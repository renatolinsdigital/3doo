import { useCallback } from 'react';

import {
  type ExportObject,
  exportFBXAscii,
  exportOBJ,
  importOBJ,
  parseProject,
  stringifyProject,
} from '@kernel/index';
import { evaluatedMesh, useEditorStore } from '@store/index';

import {
  clearAssets,
  hydrateAssets,
  imageDimensions,
  imageTypeFor,
  inlineAssets,
  nextAssetId,
  syncAssets,
  writeAsset,
} from '../services/assets';
import { writeAutosave } from '../services/autosave';
import {
  type SaveResult,
  IMAGE_FILE,
  MESH_FILE,
  PROJECT_FILE,
  downloadText,
  pickFile,
  pickTextFile,
  saveResultToast,
  saveTextFile,
  savedToDownloads,
  wrongKindMessage,
} from '../services/download';

/** New / save / load / import / export, kept out of the components that trigger them. */
export function useProjectFiles() {
  const newProject = useCallback(() => {
    const state = useEditorStore.getState();
    state.resetScene();
    // The browser's copy of the last project goes with it: the autosave holds
    // one project, the one being worked on, and its images would otherwise sit
    // in OPFS with nothing pointing at them.
    void clearAssets();
    // A new project starts on a cube, the way Blender's does, for the same
    // reason a fresh tab does: an empty viewport gives you nothing to try a
    // tool against. One Ctrl+Z takes it away for anyone who wants the empty
    // scene, since the reset cleared history and this is the first step on it.
    state.addPrimitive('cube');
    // The cube is where the new project starts, not an edit to it: an editor
    // left alone from here has nothing worth writing.
    useEditorStore.setState({ status: 'New project', dirty: false });
    // Discarding the scene is the one project action that used to happen in
    // silence, which reads identically to a button that did nothing at all.
    state.pushToast('info', 'Started a new project');
  }, []);

  // Reports where the save got to rather than only announcing it, because the
  // reload prompt has to know whether the file was actually written before it
  // throws the tab away.
  const saveProject = useCallback(async (): Promise<SaveResult> => {
    const state = useEditorStore.getState();
    const filename = `${state.projectName || 'untitled'}${PROJECT_FILE.extension}`;

    const document = state.snapshotDocument();
    // The file carries its own images, as base64 inside the JSON, so a .3doo
    // sent to someone opens as what was saved rather than as blank planes.
    // Kept beside the plain document rather than folded into it: the browser's
    // copy below stores its images separately and wants the plain one.
    const inlined = {
      ...document,
      assets: await inlineAssets(document.assets ?? [], state.assets),
    };

    const result = await saveTextFile(filename, stringifyProject(inlined), PROJECT_FILE);

    if (result.status === 'saved' || result.status === 'downloaded') {
      // The file is the newest copy of the project now, so the browser's is
      // brought level with it rather than left at whenever the last tick was.
      // Otherwise the next thing to ask whether anything is unsaved answers yes
      // about a project that reached the disk a moment ago.
      if (state.autosaveEnabled) {
        // With the timeline, which the file deliberately leaves out: the
        // browser's copy is where this session carries on from.
        await writeAutosave(document, state.snapshotHistory());
        void syncAssets(Object.values(state.assets));
      }
      state.markSaved();
      // FILE > NEW asks before it runs unless this is up: the browser's copy it
      // discards is one the user has a file of.
      state.markFileSaved();
    }

    const toast = saveResultToast(result);
    if (toast) state.pushToast(toast.variant, toast.message);
    return result;
  }, []);

  const openProject = useCallback(async () => {
    const state = useEditorStore.getState();
    const file = await pickTextFile(PROJECT_FILE);
    if (!file) return;

    const wrongKind = wrongKindMessage(file.name, PROJECT_FILE);
    if (wrongKind) {
      state.pushToast('error', wrongKind);
      return;
    }

    try {
      const document = parseProject(file.text);
      const assets = await hydrateAssets(document.assets ?? []);
      state.loadProjectDocument(document, true, assets);
      // Straight into the browser's store, so the project just opened is the
      // one the autosave is keeping from here on.
      if (state.autosaveEnabled) {
        for (const asset of assets) {
          if (asset.blob) await writeAsset(asset.id, asset.blob);
        }
      }
      // What is on screen is what the file holds, so nothing is pending until
      // the user changes something, and that file is on disk to go back to.
      state.markSaved();
      state.markFileSaved();
      state.pushToast('success', `Opened ${file.name}`);
    } catch (error) {
      // Named, because a bare parser message never says which file it came from
      // and the picker has already closed by the time it lands.
      state.pushToast('error', `Could not open ${file.name}: ${(error as Error).message}`);
    }
  }, []);

  const importMesh = useCallback(async () => {
    const state = useEditorStore.getState();
    const file = await pickTextFile(MESH_FILE);
    if (!file) return;

    const wrongKind = wrongKindMessage(file.name, MESH_FILE);
    if (wrongKind) {
      state.pushToast('error', wrongKind);
      return;
    }

    try {
      const imported = importOBJ(file.text);
      if (imported.length === 0) {
        state.pushToast('warning', `No geometry found in ${file.name}`);
        return;
      }

      state.recordHistory('Import OBJ');
      for (const entry of imported) {
        // Reuse the primitive path to get a fully formed scene object, then
        // swap in the imported mesh.
        state.addPrimitive('plane');
        const current = useEditorStore.getState();
        const object = current.objects[current.objects.length - 1];
        object.mesh = entry.mesh;
        object.name = entry.name.toUpperCase();
        object.primitive = null;
      }
      useEditorStore.getState().touchMesh();
      state.pushToast('success', `Imported ${imported.length} object(s) from ${file.name}`);
    } catch (error) {
      state.pushToast('error', `Could not import ${file.name}: ${(error as Error).message}`);
    }
  }, []);

  const importImage = useCallback(async () => {
    const state = useEditorStore.getState();
    const file = await pickFile(IMAGE_FILE);
    if (!file) return;

    const wrongKind = wrongKindMessage(file.name, IMAGE_FILE);
    if (wrongKind) {
      state.pushToast('error', wrongKind);
      return;
    }

    try {
      const type = imageTypeFor(file.name, file.type);
      const { width, height } = await imageDimensions(file);
      const asset = { id: nextAssetId(), name: file.name, type, width, height, blob: file };

      state.addImage(asset);
      // Written now rather than at the next autosave tick, so a tab closed
      // straight after an import still has the picture in it.
      if (state.autosaveEnabled) await writeAsset(asset.id, file);

      state.pushToast('success', `Imported ${file.name} (${width} by ${height})`);
    } catch (error) {
      state.pushToast('error', `Could not import ${file.name}: ${(error as Error).message}`);
    }
  }, []);

  const collectExportObjects = useCallback((selectionOnly: boolean): ExportObject[] => {
    const state = useEditorStore.getState();
    return state.objects
      .filter((object) => object.visible)
      .filter((object) => !selectionOnly || state.selectedObjectIds.includes(object.id))
      .map((object) => ({
        name: object.name.replace(/\s+/g, '_'),
        // Export the evaluated mesh so modifiers are baked into the output.
        mesh: evaluatedMesh(object),
        transform: object.transform,
        materials: object.materials,
      }));
  }, []);

  const exportModel = useCallback(
    (format: 'obj' | 'fbx', selectionOnly = false) => {
      const state = useEditorStore.getState();
      const objects = collectExportObjects(selectionOnly);

      if (objects.length === 0) {
        // Hidden objects are filtered out too, so "nothing to export" on a scene
        // that visibly has objects in it is otherwise baffling.
        state.pushToast(
          'warning',
          selectionOnly
            ? 'Nothing selected to export'
            : 'Nothing to export: the scene is empty or every object is hidden',
        );
        return;
      }

      const name = state.projectName || 'model';
      try {
        if (format === 'obj') {
          const { obj, mtl } = exportOBJ(objects, state.exportOptions);
          downloadText(`${name}.obj`, obj, 'text/plain');
          downloadText(`${name}.mtl`, mtl, 'text/plain');
          // Both files are named: an OBJ arrives with a material file beside it,
          // and someone who only knows about the .obj leaves the .mtl behind.
          state.pushToast('success', savedToDownloads(`${name}.obj`, `${name}.mtl`));
          return;
        }

        downloadText(`${name}.fbx`, exportFBXAscii(objects, state.exportOptions), 'text/plain');
        state.pushToast('success', savedToDownloads(`${name}.fbx`));
      } catch (error) {
        state.pushToast('error', `Export failed: ${(error as Error).message}`);
      }
    },
    [collectExportObjects],
  );

  return { newProject, saveProject, openProject, importMesh, importImage, exportModel };
}
