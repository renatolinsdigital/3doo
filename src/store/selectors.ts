import { useShallow } from 'zustand/react/shallow';

import type { SceneObject, SceneStats } from './types';
import { type EditorStore, useEditorStore } from './useEditorStore';

export function selectActiveObject(state: EditorStore): SceneObject | null {
  return state.objects.find((object) => object.id === state.activeObjectId) ?? null;
}

export function useActiveObject(): SceneObject | null {
  return useEditorStore(selectActiveObject);
}

/**
 * Scene counts for the status bar.
 *
 * Reads `meshVersion` so it recomputes after a geometry edit: meshes are
 * mutated in place, so there is no new reference for Zustand to compare.
 * `useShallow` is required because the selector builds a fresh object each call.
 */
export function useSceneStats(): SceneStats {
  return useEditorStore(
    useShallow((state): SceneStats => {
      void state.meshVersion;

      const totals: SceneStats = {
        verts: 0,
        edges: 0,
        faces: 0,
        tris: 0,
        objects: state.objects.length,
        selectedVerts: 0,
        selectedEdges: 0,
        selectedFaces: 0,
      };

      for (const object of state.objects) {
        if (!object.visible) continue;
        const stats = object.mesh.stats();
        totals.verts += stats.verts;
        totals.edges += stats.edges;
        totals.faces += stats.faces;
        totals.tris += stats.tris;

        if (object.id === state.activeObjectId) {
          totals.selectedVerts = stats.selectedVerts;
          totals.selectedEdges = stats.selectedEdges;
          totals.selectedFaces = stats.selectedFaces;
        }
      }

      return totals;
    }),
  );
}
