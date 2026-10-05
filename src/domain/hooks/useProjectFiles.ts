import { useCallback } from 'react';

import { exportFBX, exportOBJ, importFBX, importOBJ, parseProject } from '@kernel/index';
import { useEditorStore } from '@store/index';

import {
  blobBytes,
  exportObjects,
  exportPictures,
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
  downloadFile,
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
    // The file itself rather than its text: a binary FBX does not survive
    // being decoded as text.
    const file = await pickFile(MESH_FILE);
    if (!file) return;

    const wrongKind = wrongKindMessage(file.name, MESH_FILE);
    if (wrongKind) {
      state.pushToast('error', wrongKind);
      return;
    }

    try {
      const bytes = await blobBytes(file);
      const imported = file.name.toLowerCase().endsWith('.fbx')
        ? await importFBX(bytes)
        : importOBJ(new TextDecoder().decode(bytes));
      if (imported.length === 0) {
        state.pushToast('warning', `No geometry found in ${file.name}`);
        return;
      }

      state.addImportedObjects(imported, file.name);
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

  const exportModel = useCallback(async (format: 'obj' | 'fbx', selectionOnly = false) => {
    const state = useEditorStore.getState();
    const chosen = state.objects
      .filter((object) => object.visible)
      .filter((object) => !selectionOnly || state.selectedObjectIds.includes(object.id));

    if (chosen.length === 0) {
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
      const pictures = await exportPictures(chosen, state.assets);
      const objects = exportObjects(chosen, pictures);

      if (format === 'obj') {
        // The .obj names its material file, so the name has to be one an OBJ
        // reader takes whole: it stops at the first space.
        const library = `${name.replace(/\s+/g, '_')}.mtl`;
        const { obj, mtl } = exportOBJ(objects, state.exportOptions, library);
        downloadFile(`${name}.obj`, obj, 'text/plain');
        downloadFile(library, mtl, 'text/plain');
        // The material file points at the pictures by name, so they go beside it.
        for (const picture of pictures.values()) {
          downloadFile(picture.fileName, picture.blob, picture.type);
        }
        // Every file is named: an OBJ arrives with the others beside it, and
        // someone who only knows about the .obj leaves the rest behind.
        const images = [...pictures.values()].map((picture) => picture.fileName);
        state.pushToast('success', savedToDownloads(`${name}.obj`, library, ...images));
        return;
      }

      downloadFile(
        `${name}.fbx`,
        exportFBX(objects, state.exportOptions),
        'application/octet-stream',
      );
      state.pushToast('success', savedToDownloads(`${name}.fbx`));
    } catch (error) {
      state.pushToast('error', `Export failed: ${(error as Error).message}`);
    }
  }, []);

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
