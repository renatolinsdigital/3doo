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
 * so iteration is deterministic across runs: kernel tests depend on that.
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
  addFace(
    verts: readonly Vert[],
    options: { materialIndex?: number; smooth?: boolean } = {},
  ): Face {
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

  /**
   * How many corners a face has, without building the list to count it.
   *
   * The display pass counts every face before it fills its buffers, and at a
   * hundred thousand faces the array `faceLoops` hands back for each one is the
   * whole cost of asking.
   */
  faceLoopCount(face: Face): number {
    let count = 0;
    let loop = face.loop;
    do {
      count++;
      loop = loop.next;
    } while (loop !== face.loop && count < 4096);
    return count;
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

  /**
   * Recomputes face normals and the area-weighted vertex normals.
   *
   * With `moved`, only the geometry that could have changed: the faces around
   * those vertices, and the vertex normals of every vertex those faces touch.
   * Nothing else can have moved, so nothing else can have turned. A drag runs
   * this on every pointer move, and over a whole mesh that was the single
   * costliest thing a moved vertex set off: 281 ms on a 98k-face mesh, against
   * a couple for the handful of faces a drag actually bends.
   */
  computeNormals(moved?: Iterable<Vert>): void {
    const faces = moved ? this.facesAround(moved) : [...this.faces.values()];
    const turned = new Set(faces.map((face) => face.id));
    const verts = new Map<number, Vert>();

    // Area-weighted, so a big face pulls a shared vertex further round than a
    // sliver does, summed in place rather than through a map of vectors.
    const sums = new Map<number, { x: number; y: number; z: number }>();
    for (const face of faces) {
      this.updateFaceNormal(face);
      const weight = this.faceArea(face);
      for (const vert of this.faceVerts(face)) {
        verts.set(vert.id, vert);
        const sum = sums.get(vert.id) ?? { x: 0, y: 0, z: 0 };
        sum.x += face.normal.x * weight;
        sum.y += face.normal.y * weight;
        sum.z += face.normal.z * weight;
        sums.set(vert.id, sum);
      }
    }

    // A vertex on the edge of the moved patch also belongs to faces outside it,
    // which have not turned but still weigh on where its normal points.
    if (moved) {
      for (const vert of verts.values()) {
        const sum = sums.get(vert.id) ?? { x: 0, y: 0, z: 0 };
        for (const face of this.vertFaces(vert)) {
          if (turned.has(face.id)) continue;
          const weight = this.faceArea(face);
          sum.x += face.normal.x * weight;
          sum.y += face.normal.y * weight;
          sum.z += face.normal.z * weight;
        }
        sums.set(vert.id, sum);
      }
    }

    for (const vert of verts.values()) {
      const sum = sums.get(vert.id) ?? { x: 0, y: 0, z: 0 };
      const normal = normalize(vec3(sum.x, sum.y, sum.z));
      vert.normal = normal.x === 0 && normal.y === 0 && normal.z === 0 ? vec3(0, 1, 0) : normal;
    }

    // A vertex with no face at all still owns a normal, and a full pass is the
    // only one that can say so: nothing moved it into the set above.
    if (!moved) {
      for (const vert of this.verts.values()) {
        if (!verts.has(vert.id)) vert.normal = vec3(0, 1, 0);
      }
    }
  }

  /**
   * Shading normals for the corners a sharp edge cuts off from their vertex
   * normal, keyed by loop id.
   *
   * A smooth face shades through the vertex normal, which averages every face
   * around the vertex. A sharp edge splits that fan, and each side of it is
   * averaged on its own, so the shading breaks along the edge instead of
   * blending across it. Only the vertices a sharp edge touches are visited and
   * only corners of smooth faces come back: every other corner reads
   * `vert.normal` as it always has. So does a fan the sharp edges leave in one
   * piece, which is the last vertex of a crease that stops partway across a
   * surface, since its vertex normal is already the answer.
   */
  cornerNormals(): Map<number, Vec3> {
    const split = new Map<number, Vec3>();
    const visited = new Set<number>();

    for (const edge of this.edges.values()) {
      if (!edge.sharp) continue;
      if (!visited.has(edge.v0.id)) {
        visited.add(edge.v0.id);
        splitFan(edge.v0, split);
      }
      if (!visited.has(edge.v1.id)) {
        visited.add(edge.v1.id);
        splitFan(edge.v1, split);
      }
    }

    return split;
  }

  /** Every face touching one of these vertices, each listed once. */
  private facesAround(verts: Iterable<Vert>): Face[] {
    const seen = new Set<number>();
    const faces: Face[] = [];
    for (const vert of verts) {
      for (const face of this.vertFaces(vert)) {
        if (seen.has(face.id)) continue;
        seen.add(face.id);
        faces.push(face);
      }
    }
    return faces;
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
      // Counted rather than listed: the status bar reads this on every store
      // change, and a list built per face is the whole cost of it.
      tris += Math.max(0, this.faceLoopCount(face) - 2);
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
        if (!this.edges.has(edge.id))
          problems.push(`vert ${vert.id} references dead edge ${edge.id}`);
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
        if (!this.faces.has(loop.face.id))
          problems.push(`edge ${edge.id} holds a loop of dead face ${loop.face.id}`);
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

/**
 * Refilled per vertex by `splitFan` rather than allocated per vertex: it runs
 * for every vertex on a crease on every redraw, drags included.
 */
const fanCorners: Loop[] = [];
const fanSides: number[] = [];

/**
 * Averages each side of a vertex's fan on its own, area-weighted the way
 * `computeNormals` weighs the whole of it, into `into` by loop id.
 *
 * The sides are found by joining the faces across every edge that is not
 * sharp, which holds up on fans that are not a simple disc: a boundary has
 * nothing to join across, and a non-manifold edge joins every face it holds. A
 * fan that comes out in one piece writes nothing, since its vertex normal is
 * already the answer.
 *
 * Arrays searched end to end, because a fan is a handful of faces wide. The
 * same work through a few maps per vertex, writing every fan whole, measured
 * 22 ms a pass on a 51k-face sphere with one edge in twenty sharp and 100 ms
 * with all of them, against 8 and 39 this way.
 */
function splitFan(vert: Vert, into: Map<number, Vec3>): void {
  const corners = fanCorners;
  const sides = fanSides;
  corners.length = 0;
  for (const edge of vert.edges) {
    for (const loop of edge.loops) {
      const corner = cornerAt(vert, loop);
      if (!corners.includes(corner)) corners.push(corner);
    }
  }

  // Every corner starts as a side of its own.
  sides.length = corners.length;
  for (let i = 0; i < corners.length; i++) sides[i] = i;
  for (const edge of vert.edges) {
    if (edge.sharp || edge.loops.length < 2) continue;
    const root = sideOf(corners.indexOf(cornerAt(vert, edge.loops[0])));
    for (let i = 1; i < edge.loops.length; i++) {
      const other = sideOf(corners.indexOf(cornerAt(vert, edge.loops[i])));
      if (other !== root) sides[other] = root;
    }
  }

  let pieces = 0;
  for (let i = 0; i < corners.length; i++) {
    sides[i] = sideOf(i);
    if (sides[i] === i) pieces++;
  }
  if (pieces < 2) return;

  for (let root = 0; root < corners.length; root++) {
    if (sides[root] !== root) continue;

    let members = 0;
    let smooth = false;
    for (let i = 0; i < corners.length; i++) {
      if (sides[i] !== root) continue;
      members++;
      smooth ||= corners[i].face.smooth;
    }
    if (!smooth) continue;

    // A side of one face shades as that face does, which is every side of a
    // mesh marked sharp all over: no average to take, and nothing to allocate.
    if (members === 1) {
      into.set(corners[root].id, corners[root].face.normal);
      continue;
    }

    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < corners.length; i++) {
      if (sides[i] !== root) continue;
      const { face } = corners[i];
      const weight = loopArea(face);
      x += face.normal.x * weight;
      y += face.normal.y * weight;
      z += face.normal.z * weight;
    }

    const normal = normalize(vec3(x, y, z));
    const degenerate = normal.x === 0 && normal.y === 0 && normal.z === 0;
    for (let i = 0; i < corners.length; i++) {
      const corner = corners[i];
      if (sides[i] !== root || !corner.face.smooth) continue;
      into.set(corner.id, degenerate ? corner.face.normal : normal);
    }
  }
}

/**
 * A face's corner at `vert`, from a loop on an edge through it: the loop starts
 * at whichever end of the edge its face's winding reaches first.
 */
function cornerAt(vert: Vert, loop: Loop): Loop {
  return loop.vert === vert ? loop : loop.next;
}

/** The side a corner of the fan `splitFan` is filling belongs to. */
function sideOf(corner: number): number {
  let root = corner;
  while (fanSides[root] !== root) root = fanSides[root];
  return root;
}

/**
 * The same sum as `polygonArea`, walked off the loops so no array is built for
 * a face that is asked about once per corner.
 */
function loopArea(face: Face): number {
  let x = 0;
  let y = 0;
  let z = 0;
  let loop = face.loop;
  let corners = 0;
  do {
    const a = loop.vert.co;
    const b = loop.next.vert.co;
    x += a.y * b.z - a.z * b.y;
    y += a.z * b.x - a.x * b.z;
    z += a.x * b.y - a.y * b.x;
    loop = loop.next;
  } while (loop !== face.loop && ++corners < 4096);
  return Math.sqrt(x * x + y * y + z * z) * 0.5;
}
