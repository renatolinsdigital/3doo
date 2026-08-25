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
  MESH_FILE,
  PROJECT_FILE,
  downloadText,
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
    // Discarding the scene is the one project action that used to happen in
    // silence, which reads identically to a button that did nothing at all.
    state.pushToast('info', 'Started a new project');
  }, []);

  const saveProject = useCallback(async () => {
    const state = useEditorStore.getState();
    const filename = `${state.projectName || 'untitled'}${PROJECT_FILE.extension}`;

    const result = await saveTextFile(
      filename,
      stringifyProject(state.snapshotDocument()),
      PROJECT_FILE,
    );

    const toast = saveResultToast(result);
    if (toast) state.pushToast(toast.variant, toast.message);
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
      state.loadProjectDocument(parseProject(file.text));
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
            : 'Nothing to export — the scene is empty or every object is hidden',
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

  return { newProject, saveProject, openProject, importMesh, exportModel };
}
