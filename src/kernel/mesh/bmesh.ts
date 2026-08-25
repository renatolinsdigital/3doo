import {
  type Vec3,
  add,
  centroid,
  clone,
  mul,
  normalize,
  polygonArea,
  polygonNormal,
  vec3,
} from '../math';

import type { Edge, Face, Loop, MeshStats, SelectMode, Vert } from './types';

/**
 * BMesh-style half-edge mesh: verts, edges, and per-face loop cycles.
 *
 * Every element is stored in an insertion-ordered Map keyed by a monotonic id,
 * so iteration is deterministic across runs — kernel tests depend on that.
 */
export class BMesh {
  readonly verts = new Map<number, Vert>();
  readonly edges = new Map<number, Edge>();
  readonly faces = new Map<number, Face>();

  private nextVertId = 1;
  private nextEdgeId = 1;
  private nextLoopId = 1;
  private nextFaceId = 1;
  private nextSelectSeq = 1;

  // ---------------------------------------------------------------- creation

  addVert(co: Vec3): Vert {
    const vert: Vert = {
      id: this.nextVertId++,
      co: clone(co),
      edges: [],
      selected: false,
      selectSeq: 0,
      normal: vec3(0, 1, 0),
    };
    this.verts.set(vert.id, vert);
    return vert;
  }

  addEdge(v0: Vert, v1: Vert): Edge {
    if (v0 === v1) throw new Error(`Cannot create a degenerate edge on vertex ${v0.id}`);
    const existing = this.findEdge(v0, v1);
    if (existing) return existing;

    const edge: Edge = {
      id: this.nextEdgeId++,
      v0,
      v1,
      loops: [],
      selected: false,
      sharp: false,
    };
    this.edges.set(edge.id, edge);
    v0.edges.push(edge);
    v1.edges.push(edge);
    return edge;
  }

  /**
   * Creates a face from an ordered vertex ring. Missing edges are created on
   * demand. Returns the existing face when one already spans the same ring,
   * which keeps operations that re-fill a region idempotent.
   */
  addFace(verts: readonly Vert[], options: { materialIndex?: number; smooth?: boolean } = {}): Face {
    if (verts.length < 3) {
      throw new Error(`A face needs at least 3 vertices, received ${verts.length}`);
    }
    const duplicate = this.findFace(verts);
    if (duplicate) return duplicate;

    // The loop cycle is inherently cyclic, so `loop`, `face`, `next` and `prev`
    // are patched in below before the face becomes reachable from the mesh.
    const face: Face = {
      id: this.nextFaceId++,
      loop: undefined as unknown as Loop,
      normal: vec3(0, 1, 0),
      materialIndex: options.materialIndex ?? 0,
      selected: false,
      smooth: options.smooth ?? false,
    };

    const loops: Loop[] = [];
    for (let i = 0; i < verts.length; i++) {
      const vert = verts[i];
      const next = verts[(i + 1) % verts.length];
      const edge = this.addEdge(vert, next);
      const loop: Loop = {
        id: this.nextLoopId++,
        vert,
        edge,
        face,
        next: undefined as unknown as Loop,
        prev: undefined as unknown as Loop,
        uv: { u: 0, v: 0 },
      };
      edge.loops.push(loop);
      loops.push(loop);
    }

    for (let i = 0; i < loops.length; i++) {
      loops[i].next = loops[(i + 1) % loops.length];
      loops[i].prev = loops[(i - 1 + loops.length) % loops.length];
    }

    face.loop = loops[0];
    this.faces.set(face.id, face);
    this.updateFaceNormal(face);
    return face;
  }

  // ---------------------------------------------------------------- deletion

  removeFace(face: Face): void {
    if (!this.faces.has(face.id)) return;
    for (const loop of this.faceLoops(face)) {
      const index = loop.edge.loops.indexOf(loop);
      if (index >= 0) loop.edge.loops.splice(index, 1);
    }
    this.faces.delete(face.id);
  }

  removeEdge(edge: Edge): void {
    if (!this.edges.has(edge.id)) return;
    for (const face of this.edgeFaces(edge)) this.removeFace(face);
    for (const vert of [edge.v0, edge.v1]) {
      const index = vert.edges.indexOf(edge);
      if (index >= 0) vert.edges.splice(index, 1);
    }
    this.edges.delete(edge.id);
  }

  removeVert(vert: Vert): void {
    if (!this.verts.has(vert.id)) return;
    for (const edge of [...vert.edges]) this.removeEdge(edge);
    this.verts.delete(vert.id);
  }

  /**
   * Drops vertices that no longer belong to any edge.
   *
   * `keep` spares ids the caller recorded as already loose beforehand, so a
   * cleanup pass sweeps up its own debris without deleting isolated points the
   * mesh legitimately holds.
   */
  removeLooseVerts(keep?: ReadonlySet<number>): number {
    let removed = 0;
    for (const vert of [...this.verts.values()]) {
      if (vert.edges.length === 0 && !keep?.has(vert.id)) {
        this.verts.delete(vert.id);
        removed++;
      }
    }
    return removed;
  }

  /** Drops edges that no longer border any face, sparing the ids in `keep`. */
  removeWireEdges(keep?: ReadonlySet<number>): number {
    let removed = 0;
    for (const edge of [...this.edges.values()]) {
      if (edge.loops.length === 0 && !keep?.has(edge.id)) {
        this.removeEdge(edge);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.verts.clear();
    this.edges.clear();
    this.faces.clear();
  }

  // ----------------------------------------------------------------- queries

  findEdge(v0: Vert, v1: Vert): Edge | null {
    for (const edge of v0.edges) {
      if ((edge.v0 === v0 && edge.v1 === v1) || (edge.v0 === v1 && edge.v1 === v0)) return edge;
    }
    return null;
  }

  /** Finds a face spanning exactly this vertex set, regardless of winding. */
  findFace(verts: readonly Vert[]): Face | null {
    if (verts.length === 0) return null;
    const target = new Set(verts.map((v) => v.id));
    for (const face of this.vertFaces(verts[0])) {
      const faceVerts = this.faceVerts(face);
      if (faceVerts.length !== target.size) continue;
      if (faceVerts.every((v) => target.has(v.id))) return face;
    }
    return null;
  }

  faceLoops(face: Face): Loop[] {
    const loops: Loop[] = [];
    let loop = face.loop;
    do {
      loops.push(loop);
      loop = loop.next;
    } while (loop !== face.loop && loops.length < 4096);
    return loops;
  }

  faceVerts(face: Face): Vert[] {
    return this.faceLoops(face).map((loop) => loop.vert);
  }

  faceEdges(face: Face): Edge[] {
    return this.faceLoops(face).map((loop) => loop.edge);
  }

  facePoints(face: Face): Vec3[] {
    return this.faceLoops(face).map((loop) => loop.vert.co);
  }

  faceCenter(face: Face): Vec3 {
    return centroid(this.facePoints(face));
  }

  faceArea(face: Face): number {
    return polygonArea(this.facePoints(face));
  }

  edgeFaces(edge: Edge): Face[] {
    const seen = new Set<number>();
    const faces: Face[] = [];
    for (const loop of edge.loops) {
      if (seen.has(loop.face.id)) continue;
      seen.add(loop.face.id);
      faces.push(loop.face);
    }
    return faces;
  }

  edgeCenter(edge: Edge): Vec3 {
    return mul(add(edge.v0.co, edge.v1.co), 0.5);
  }

  edgeOther(edge: Edge, vert: Vert): Vert {
    return edge.v0 === vert ? edge.v1 : edge.v0;
  }

  vertFaces(vert: Vert): Face[] {
    const seen = new Set<number>();
    const faces: Face[] = [];
    for (const edge of vert.edges) {
      for (const face of this.edgeFaces(edge)) {
        if (seen.has(face.id)) continue;
        seen.add(face.id);
        faces.push(face);
      }
    }
    return faces;
  }

  /** Loops inside `face` that start at `vert`, i.e. the face's corner there. */
  loopOfVertInFace(face: Face, vert: Vert): Loop | null {
    for (const loop of this.faceLoops(face)) {
      if (loop.vert === vert) return loop;
    }
    return null;
  }

  isBoundaryEdge(edge: Edge): boolean {
    return edge.loops.length === 1;
  }

  isWireEdge(edge: Edge): boolean {
    return edge.loops.length === 0;
  }

  isNonManifoldEdge(edge: Edge): boolean {
    return edge.loops.length > 2;
  }

  // ----------------------------------------------------------------- normals

  updateFaceNormal(face: Face): void {
    face.normal = polygonNormal(this.facePoints(face));
  }

  /** Recomputes every face normal and the area-weighted vertex normals. */
  computeNormals(): void {
    const accumulator = new Map<number, Vec3>();
    for (const vert of this.verts.values()) accumulator.set(vert.id, vec3());

    for (const face of this.faces.values()) {
      this.updateFaceNormal(face);
      const weight = this.faceArea(face);
      for (const vert of this.faceVerts(face)) {
        const current = accumulator.get(vert.id) ?? vec3();
        accumulator.set(vert.id, add(current, mul(face.normal, weight)));
      }
    }

    for (const vert of this.verts.values()) {
      const sum = accumulator.get(vert.id) ?? vec3();
      const normal = normalize(sum);
      vert.normal = normal.x === 0 && normal.y === 0 && normal.z === 0 ? vec3(0, 1, 0) : normal;
    }
  }

  // --------------------------------------------------------------- selection

  selectedVerts(): Vert[] {
    return [...this.verts.values()].filter((v) => v.selected);
  }

  /** Selects a vertex and stamps it with the current click-selection order. */
  selectVert(vert: Vert): void {
    vert.selected = true;
    vert.selectSeq = this.nextSelectSeq++;
  }

  selectedEdges(): Edge[] {
    return [...this.edges.values()].filter((e) => e.selected);
  }

  selectedFaces(): Face[] {
    return [...this.faces.values()].filter((f) => f.selected);
  }

  deselectAll(): void {
    for (const vert of this.verts.values()) vert.selected = false;
    for (const edge of this.edges.values()) edge.selected = false;
    for (const face of this.faces.values()) face.selected = false;
  }

  selectAll(): void {
    for (const vert of this.verts.values()) vert.selected = true;
    for (const edge of this.edges.values()) edge.selected = true;
    for (const face of this.faces.values()) face.selected = true;
  }

  /**
   * Propagates selection from the mode's primary element type to the other two,
   * the way Blender's selection flush does. Every operator reads selection
   * through this, so a face op still sees the right faces after a vertex drag.
   */
  flushSelection(mode: SelectMode): void {
    if (mode === 'vertex') {
      for (const edge of this.edges.values()) {
        edge.selected = edge.v0.selected && edge.v1.selected;
      }
      for (const face of this.faces.values()) {
        face.selected = this.faceVerts(face).every((v) => v.selected);
      }
      return;
    }

    if (mode === 'edge') {
      for (const vert of this.verts.values()) vert.selected = false;
      for (const edge of this.edges.values()) {
        if (!edge.selected) continue;
        edge.v0.selected = true;
        edge.v1.selected = true;
      }
      for (const face of this.faces.values()) {
        face.selected = this.faceEdges(face).every((e) => e.selected);
      }
      return;
    }

    for (const vert of this.verts.values()) vert.selected = false;
    for (const edge of this.edges.values()) edge.selected = false;
    for (const face of this.faces.values()) {
      if (!face.selected) continue;
      for (const loop of this.faceLoops(face)) {
        loop.vert.selected = true;
        loop.edge.selected = true;
      }
    }
  }

  // ------------------------------------------------------------------- stats

  stats(): MeshStats {
    let tris = 0;
    let selectedFaces = 0;
    for (const face of this.faces.values()) {
      tris += Math.max(0, this.faceLoops(face).length - 2);
      if (face.selected) selectedFaces++;
    }
    let selectedVerts = 0;
    for (const vert of this.verts.values()) if (vert.selected) selectedVerts++;
    let selectedEdges = 0;
    for (const edge of this.edges.values()) if (edge.selected) selectedEdges++;

    return {
      verts: this.verts.size,
      edges: this.edges.size,
      faces: this.faces.size,
      tris,
      selectedVerts,
      selectedEdges,
      selectedFaces,
    };
  }

  boundingBox(): { min: Vec3; max: Vec3 } {
    if (this.verts.size === 0) return { min: vec3(), max: vec3() };
    const min = vec3(Infinity, Infinity, Infinity);
    const max = vec3(-Infinity, -Infinity, -Infinity);
    for (const vert of this.verts.values()) {
      min.x = Math.min(min.x, vert.co.x);
      min.y = Math.min(min.y, vert.co.y);
      min.z = Math.min(min.z, vert.co.z);
      max.x = Math.max(max.x, vert.co.x);
      max.y = Math.max(max.y, vert.co.y);
      max.z = Math.max(max.z, vert.co.z);
    }
    return { min, max };
  }

  /**
   * Structural self-check used by kernel tests. Returns the problems found so a
   * failing test can report what broke rather than just "expected true".
   */
  validate(): string[] {
    const problems: string[] = [];

    for (const vert of this.verts.values()) {
      for (const edge of vert.edges) {
        if (!this.edges.has(edge.id)) problems.push(`vert ${vert.id} references dead edge ${edge.id}`);
        if (edge.v0 !== vert && edge.v1 !== vert) {
          problems.push(`vert ${vert.id} references edge ${edge.id} that does not contain it`);
        }
      }
    }

    for (const edge of this.edges.values()) {
      if (!this.verts.has(edge.v0.id) || !this.verts.has(edge.v1.id)) {
        problems.push(`edge ${edge.id} references a dead vertex`);
      }
      if (edge.v0 === edge.v1) problems.push(`edge ${edge.id} is degenerate`);
      for (const loop of edge.loops) {
        if (!this.faces.has(loop.face.id)) problems.push(`edge ${edge.id} holds a loop of dead face ${loop.face.id}`);
      }
    }

    for (const face of this.faces.values()) {
      const loops = this.faceLoops(face);
      if (loops.length < 3) problems.push(`face ${face.id} has ${loops.length} loops`);
      const seen = new Set<number>();
      for (const loop of loops) {
        if (seen.has(loop.vert.id)) problems.push(`face ${face.id} repeats vertex ${loop.vert.id}`);
        seen.add(loop.vert.id);
        if (loop.next.prev !== loop) problems.push(`face ${face.id} has a broken loop cycle`);
        if (loop.face !== face) problems.push(`loop ${loop.id} points at the wrong face`);
        if (!loop.edge.loops.includes(loop)) {
          problems.push(`loop ${loop.id} is missing from the radial set of edge ${loop.edge.id}`);
        }
        const expected = this.findEdge(loop.vert, loop.next.vert);
        if (expected !== loop.edge) problems.push(`loop ${loop.id} carries the wrong edge`);
      }
    }

    return problems;
  }
}
