import type { BMesh } from '../mesh';
import type { Edge, Face, Vert } from '../mesh/types';
import { selectLinked } from './select';

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

export interface DeleteLooseResult {
  pieces: number;
  verts: number;
  edges: number;
  faces: number;
}

/**
 * Removes every piece of the mesh but the main one: the piece with the most
 * vertices, edges and faces between them. A piece is whatever edges join, so a
 * stray vertex, a wire edge and a floating face are each a piece of their own.
 *
 * Of two pieces the same size, the one built first stays.
 */
export function deleteLoose(mesh: BMesh): DeleteLooseResult {
  const pieceOf = new Map<number, number>();
  const pieces: Vert[][] = [];
  for (const vert of mesh.verts.values()) {
    if (pieceOf.has(vert.id)) continue;
    const piece = selectLinked(mesh, [vert]);
    for (const member of piece) pieceOf.set(member.id, pieces.length);
    pieces.push(piece);
  }

  if (pieces.length < 2) return { pieces: 0, verts: 0, edges: 0, faces: 0 };

  const sizes = pieces.map((piece) => piece.length);
  for (const edge of mesh.edges.values()) sizes[pieceOf.get(edge.v0.id) as number]++;
  for (const face of mesh.faces.values()) sizes[pieceOf.get(face.loop.vert.id) as number]++;

  let main = 0;
  for (let index = 1; index < sizes.length; index++) {
    if (sizes[index] > sizes[main]) main = index;
  }

  const before = { verts: mesh.verts.size, edges: mesh.edges.size, faces: mesh.faces.size };
  pieces.forEach((piece, index) => {
    if (index !== main) for (const vert of piece) mesh.removeVert(vert);
  });

  return {
    pieces: pieces.length - 1,
    verts: before.verts - mesh.verts.size,
    edges: before.edges - mesh.edges.size,
    faces: before.faces - mesh.faces.size,
  };
}
