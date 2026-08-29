import { useShallow } from 'zustand/react/shallow';

import { type BMesh, canLoopCut, hasAdjacentFaces, hasConnectedEdges } from '@kernel/index';

import { activeObject } from './slices/scene';
import type { SceneObject, SceneStats } from './types';
import { type EditorStore, useEditorStore } from './useEditorStore';

/**
 * Asks `test` about the active object's mesh in edit mode; false anywhere else.
 *
 * Reads `meshVersion` for the reason `useSceneStats` does — selection lives on
 * the mesh, which is mutated in place, so nothing changes identity when it
 * moves. Shared so a probe cannot be written without it and quietly go stale.
 */
function useEditModeMesh(test: (mesh: BMesh, state: EditorStore) => boolean): boolean {
  return useEditorStore((state) => {
    void state.meshVersion;

    if (state.mode !== 'edit') return false;
    const object = activeObject(state);
    return object ? test(object.mesh, state) : false;
  });
}

export function useActiveObject(): SceneObject | null {
  return useEditorStore(activeObject);
}

/**
 * Whether every face of the active object is shaded smooth.
 *
 * All of them rather than any: shading is per face, and a mesh with one flat
 * patch left in it is not a smooth-shaded object. The scan stops at the first
 * flat face, so the common answer costs one look.
 */
export function useActiveShadingSmooth(): boolean {
  return useEditorStore((state) => {
    void state.meshVersion;

    const object = activeObject(state);
    if (!object || object.mesh.faces.size === 0) return false;
    for (const face of object.mesh.faces.values()) if (!face.smooth) return false;
    return true;
  });
}

/**
 * Whether the selection names a face loop.
 *
 * Counts alone cannot answer this: two faces on opposite sides of a cube are
 * still two faces, and the operator would refuse them. Adjacency is the part
 * that decides, so the button has to ask about adjacency.
 *
 * Only that a pair touches, not that the walk succeeds — a ring stops at
 * triangles and n-gons, and running it on every selection change to catch that
 * rarer case is not worth the walk. The operator still explains it when it
 * happens.
 */
export function useFaceLoopAvailable(): boolean {
  return useEditModeMesh((mesh, state) => {
    if (state.selectMode !== 'face') return false;

    const faces = mesh.selectedFaces();
    return faces.length >= 2 && hasAdjacentFaces(mesh, faces);
  });
}

/**
 * Whether the selection names an edge loop.
 *
 * Counts alone cannot answer this one either: two edges on opposite sides of a
 * cube are still two edges, and no single loop runs through them. That they
 * meet is what says the user drew along a loop, so meeting is what the button
 * asks about.
 *
 * Only that two of them touch, not that the walk gets anywhere — a loop stops
 * at the first vertex that is not valence four, and walking the mesh on every
 * selection change to find that out is not worth it. The operator still says so
 * when it happens.
 */
export function useEdgeLoopAvailable(): boolean {
  return useEditModeMesh((mesh, state) => {
    if (state.selectMode !== 'edge') return false;

    const edges = mesh.selectedEdges();
    return edges.length >= 2 && hasConnectedEdges(edges);
  });
}

/**
 * Whether the edge a loop cut would start from has a quad ring to run along.
 *
 * The operator cuts across `selectedEdges()[0]`, so that is the edge asked
 * about here. Cheap the way `useFaceLoopAvailable` is: only the faces on the
 * edge itself are read, never the ring the cut would walk.
 */
export function useLoopCutAvailable(): boolean {
  return useEditModeMesh((mesh) => {
    const [edge] = mesh.selectedEdges();
    return edge !== undefined && canLoopCut(mesh, edge);
  });
}

export interface SelectionCounts {
  verts: number;
  edges: number;
  faces: number;
}

/**
 * What is selected on the active object — the thing that decides whether an
 * edit-mode operator has anything to act on.
 *
 * Reads `meshVersion` for the same reason `useSceneStats` does: selection lives
 * on the mesh, which is mutated in place, so nothing changes identity when it
 * moves.
 */
export function useActiveSelectionCounts(): SelectionCounts {
  return useEditorStore(
    useShallow((state): SelectionCounts => {
      void state.meshVersion;

      const object = activeObject(state);
      if (!object) return { verts: 0, edges: 0, faces: 0 };

      const stats = object.mesh.stats();
      return {
        verts: stats.selectedVerts,
        edges: stats.selectedEdges,
        faces: stats.selectedFaces,
      };
    }),
  );
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
