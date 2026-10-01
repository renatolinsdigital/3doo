import type { BMesh } from '../mesh';
import type { Edge, Face, Vert } from '../mesh/types';

export type DeleteMode = 'verts' | 'edges' | 'faces' | 'onlyFaces' | 'edgesAndFaces';

/**
 * Delete removes geometry outright. Dissolve, in `dissolve.ts`, is the other
 * path: it removes topology while keeping the surrounding surface.
 */
export function deleteGeometry(
  mesh: BMesh,
  selection: { verts: readonly Vert[]; edges: readonly Edge[]; faces: readonly Face[] },
  mode: DeleteMode,
): void {
  switch (mode) {
    case 'verts':
      for (const vert of selection.verts) mesh.removeVert(vert);
      break;

    case 'edges':
    case 'edgesAndFaces':
      for (const edge of selection.edges) mesh.removeEdge(edge);
      mesh.removeLooseVerts();
      break;

    case 'faces': {
      const edges = new Set<Edge>();
      for (const face of selection.faces) {
        for (const edge of mesh.faceEdges(face)) edges.add(edge);
        mesh.removeFace(face);
      }
      for (const edge of edges) {
        if (mesh.edges.has(edge.id) && edge.loops.length === 0) mesh.removeEdge(edge);
      }
      mesh.removeLooseVerts();
      break;
    }

    case 'onlyFaces':
      for (const face of selection.faces) mesh.removeFace(face);
      break;
  }

  mesh.computeNormals();
}
