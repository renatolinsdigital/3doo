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

import { downloadText, pickTextFile } from '../services/download';

/** Save / load / import / export, kept out of the components that trigger them. */
export function useProjectFiles() {
  const saveProject = useCallback(() => {
    const state = useEditorStore.getState();
    downloadText(
      `${state.projectName || 'untitled'}.3doo.json`,
      stringifyProject(state.snapshotDocument()),
      'application/json',
    );
    state.pushToast('success', 'Project saved');
  }, []);

  const openProject = useCallback(async () => {
    const state = useEditorStore.getState();
    const file = await pickTextFile('.json,application/json');
    if (!file) return;

    try {
      state.loadProjectDocument(parseProject(file.text));
      state.pushToast('success', `Loaded ${file.name}`);
    } catch (error) {
      state.pushToast('error', (error as Error).message);
    }
  }, []);

  const importMesh = useCallback(async () => {
    const state = useEditorStore.getState();
    const file = await pickTextFile('.obj');
    if (!file) return;

    try {
      const imported = importOBJ(file.text);
      if (imported.length === 0) {
        state.pushToast('warning', 'No geometry found in that file');
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
      state.pushToast('success', `Imported ${imported.length} object(s)`);
    } catch (error) {
      state.pushToast('error', `Import failed: ${(error as Error).message}`);
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
        state.pushToast('warning', 'Nothing to export');
        return;
      }

      const name = state.projectName || 'model';
      try {
        if (format === 'obj') {
          const { obj, mtl } = exportOBJ(objects, state.exportOptions);
          downloadText(`${name}.obj`, obj, 'text/plain');
          downloadText(`${name}.mtl`, mtl, 'text/plain');
          state.pushToast('success', `Exported ${name}.obj`);
          return;
        }

        downloadText(`${name}.fbx`, exportFBXAscii(objects, state.exportOptions), 'text/plain');
        state.pushToast('success', `Exported ${name}.fbx`);
      } catch (error) {
        state.pushToast('error', `Export failed: ${(error as Error).message}`);
      }
    },
    [collectExportObjects],
  );

  return { saveProject, openProject, importMesh, exportModel };
}
