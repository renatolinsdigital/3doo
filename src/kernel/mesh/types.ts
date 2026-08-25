import type { Vec3 } from '../math';

export interface Vert {
  id: number;
  co: Vec3;
  edges: Edge[];
  selected: boolean;
  /** Click-selection order stamp; lets ops like merge tell first-picked from last-picked. */
  selectSeq: number;
  /** Cached area-weighted vertex normal; only valid after `computeNormals`. */
  normal: Vec3;
}

export interface Edge {
  id: number;
  v0: Vert;
  v1: Vert;
  /**
   * Radial set. Blender threads these as a linked cycle; an array carries the
   * same information and cannot desynchronise from itself, which matters more
   * here than the O(1) splice.
   */
  loops: Loop[];
  selected: boolean;
  /** Marks the edge as a hard crease for shading and bevel weighting. */
  sharp: boolean;
}

export interface Loop {
  id: number;
  vert: Vert;
  edge: Edge;
  face: Face;
  next: Loop;
  prev: Loop;
  uv: { u: number; v: number };
}

export interface Face {
  id: number;
  /** Entry point into the loop cycle; `loop.next` walks the winding order. */
  loop: Loop;
  normal: Vec3;
  materialIndex: number;
  selected: boolean;
  smooth: boolean;
}

export type SelectMode = 'vertex' | 'edge' | 'face';

export interface MeshStats {
  verts: number;
  edges: number;
  faces: number;
  tris: number;
  selectedVerts: number;
  selectedEdges: number;
  selectedFaces: number;
}
