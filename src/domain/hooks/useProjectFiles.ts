import { useCallback } from 'react';

import {
  type ExportObject,
  exportFBXAscii,
  exportOBJ,
  importOBJ,
  parseProject,
} from '@kernel/index';
import { evaluatedMesh, useEditorStore } from '@store/index';

import {
  hydrateAssets,
  imageDimensions,
  imageTypeFor,
  nextAssetId,
  projectText,
} from '../services/assets';
import { sceneFingerprint } from '../services/autosave';
import {
  type SaveResult,
  IMAGE_FILE,
  MESH_FILE,
  PROJECT_FILE,
  downloadText,
  overwriteTextFile,
  pickFile,
  pickTextFile,
  saveResultToast,
  saveTarget,
  saveTextFile,
  savedToDownloads,
  withoutProjectSuffix,
  wrongKindMessage,
} from '../services/download';

/**
 * Writes the project out through `write`, and settles what a save settles.
 *
 * SAVE and SAVE AS differ only in where the text goes. Reports where the save
 * got to rather than only announcing it, because the reload prompt has to know
 * whether the file was actually written before it throws the tab away.
 */
async function writeProject(write: (contents: string) => Promise<SaveResult>): Promise<SaveResult> {
  const state = useEditorStore.getState();

  const document = state.snapshotDocument();
  // The file carries its own images, as base64 inside the JSON, so a .3doo
  // sent to someone opens as what was saved rather than as blank planes.
  const result = await write(await projectText(document, state.assets));

  if (result.status === 'saved' || result.status === 'downloaded') {
    // A download is out of the page's reach once it lands, so it leaves
    // nothing for SAVE to write over.
    const file = result.status === 'saved' ? result.handle : null;
    // The top bar carries the name of the file SAVE writes over, and the save
    // dialog may have settled on another than the one it was offered. Renamed
    // ahead of the marks below, which a rename would otherwise take away.
    if (file) state.setProjectName(withoutProjectSuffix(file.name));
    // So the next autosave tick, finding the scene touched but not changed
    // since, does not write a copy of what the file already holds.
    state.markSaved(sceneFingerprint(document));
    // FILE > NEW and FILE > OPEN ask before they run unless this is up: what
    // they discard is a scene the user has a file of.
    state.markFileSaved();
    state.setProjectFile(file);
  }

  const toast = saveResultToast(result);
  if (toast) state.pushToast(toast.variant, toast.message);
  return result;
}

/** New / save / load / import / export, kept out of the components that trigger them. */
export function useProjectFiles() {
  const newProject = useCallback(() => {
    const state = useEditorStore.getState();
    state.resetScene();
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

  const saveProjectAs = useCallback((): Promise<SaveResult> => {
    const { projectName } = useEditorStore.getState();
    const filename = `${projectName || 'untitled'}${PROJECT_FILE.extension}`;
    return writeProject((contents) => saveTextFile(filename, contents, PROJECT_FILE));
  }, []);

  // SAVE AS while there is nothing to write over, no file yet or a project
  // renamed away from it: Ctrl+S and the prompts that offer a save before a
  // project is replaced reach here either way, and have to end with a file.
  const saveProject = useCallback((): Promise<SaveResult> => {
    const { projectFile, projectName } = useEditorStore.getState();
    const file = saveTarget(projectFile, projectName);
    if (!file) return saveProjectAs();
    return writeProject((contents) => overwriteTextFile(file, contents));
  }, [saveProjectAs]);

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
      // Named after the file rather than the name saved inside it: the top bar
      // names the file SAVE writes over, and a file renamed on disk would
      // otherwise open with SAVE already greyed out.
      state.loadProjectDocument(
        { ...document, name: withoutProjectSuffix(file.name) },
        true,
        hydrateAssets(document.assets ?? []),
      );
      // The steps behind the project this file replaced are not steps behind
      // this one. Left in place, one Ctrl+Z would undo into a scene the file
      // never held.
      state.clearHistory();
      // What is on screen is what the file holds, so nothing is pending until
      // the user changes something, and that file is on disk to go back to.
      // Fingerprinted from the scene as loaded rather than from the file,
      // because loading tidies a document and the autosave reads the scene.
      state.markSaved(sceneFingerprint(state.snapshotDocument()));
      state.markFileSaved();
      state.setProjectFile(file.handle);
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

  return {
    newProject,
    saveProject,
    saveProjectAs,
    openProject,
    importMesh,
    importImage,
    exportModel,
  };
}
