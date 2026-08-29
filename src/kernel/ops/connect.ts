import type { BMesh } from '../mesh';
import type { Edge, Face, Vert } from '../mesh/types';

export interface ConnectVertsResult {
  edge: Edge | null;
  /** The faces the split produced; empty when a bare edge was added instead. */
  faces: Face[];
  reason: 'split' | 'bare' | 'connected';
}

/**
 * Runs an edge between two vertices.
 *
 * When both sit on the same face the face is split along the new edge rather
 * than the edge simply being laid across it: a bare edge through a face divides
 * nothing, leaving geometry that looks cut but still shades and extrudes as one
 * surface. Vertices with no face in common (two loose verts, or corners of
 * different islands) get the plain edge, which is the only thing that can be
 * meant there.
 */
export function connectVerts(mesh: BMesh, a: Vert, b: Vert): ConnectVertsResult {
  if (a === b) return { edge: null, faces: [], reason: 'connected' };

  // Catches vertices that are already neighbours on a face too: consecutive
  // ring corners always have the edge between them.
  const existing = mesh.findEdge(a, b);
  if (existing) return { edge: existing, faces: [], reason: 'connected' };

  const shared = mesh.vertFaces(a).find((face) => mesh.faceVerts(face).includes(b));
  if (!shared) {
    const edge = mesh.addEdge(a, b);
    edge.selected = true;
    return { edge, faces: [], reason: 'bare' };
  }

  const ring = mesh.faceVerts(shared);
  const start = ring.indexOf(a);
  const end = ring.indexOf(b);

  // Walking the ring both ways from a to b gives the two halves. Each keeps the
  // original winding, so the split faces inherit the parent's orientation.
  const first = sliceRing(ring, start, end);
  const second = sliceRing(ring, end, start);

  const { materialIndex, smooth } = shared;
  mesh.removeFace(shared);

  const faces = [first, second].map((verts) => {
    const face = mesh.addFace(verts, { materialIndex, smooth });
    face.selected = true;
    return face;
  });

  mesh.computeNormals();
  return { edge: mesh.findEdge(a, b), faces, reason: 'split' };
}

/** The vertices from `start` to `end` inclusive, wrapping around the ring. */
function sliceRing(ring: readonly Vert[], start: number, end: number): Vert[] {
  const out: Vert[] = [];
  for (let i = start; ; i = (i + 1) % ring.length) {
    out.push(ring[i]);
    if (i === end) break;
  }
  return out;
}
