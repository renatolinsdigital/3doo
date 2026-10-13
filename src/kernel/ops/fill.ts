import {
  type Vec3,
  add,
  cross,
  distanceSq,
  dot,
  lengthSq,
  mul,
  normalize,
  polygonNormal,
  sub,
  vec3,
} from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Loop, Vert } from '../mesh/types';

interface EdgeRing {
  verts: Vert[];
  /** False for an open run, whose last vertex has no edge back to its first. */
  closed: boolean;
}

/**
 * Chains boundary edges into ordered vertex rings.
 *
 * Both fill and bridge need "which loops does this selection form", so the walk
 * lives here once.
 */
function edgeLoopsFrom(mesh: BMesh, edges: readonly Edge[]): EdgeRing[] {
  const pool = new Set(edges.filter((edge) => mesh.edges.has(edge.id)));
  const loops: EdgeRing[] = [];

  const neighbours = new Map<number, Edge[]>();
  for (const edge of pool) {
    for (const vert of [edge.v0, edge.v1]) {
      const list = neighbours.get(vert.id);
      if (list) list.push(edge);
      else neighbours.set(vert.id, [edge]);
    }
  }

  while (pool.size > 0) {
    const seed: Edge = pool.values().next().value as Edge;
    pool.delete(seed);

    const ring: Vert[] = [seed.v0, seed.v1];
    const position = new Map([
      [seed.v0.id, 0],
      [seed.v1.id, 1],
    ]);
    let head = seed.v1;
    let turned = false;
    let closed = false;

    for (;;) {
      const next = (neighbours.get(head.id) ?? []).find((edge) => pool.has(edge));
      if (!next) {
        // An open chain, and the seed can sit anywhere along it: walk on from
        // its other end too, or only the stretch ahead of the seed gets filled.
        if (turned) break;
        turned = true;
        ring.reverse();
        position.clear();
        ring.forEach((vert, index) => position.set(vert.id, index));
        head = ring[ring.length - 1];
        continue;
      }
      pool.delete(next);
      head = mesh.edgeOther(next, head);
      const seen = position.get(head.id);
      if (seen === 0) {
        closed = true;
        break;
      }
      if (seen !== undefined) {
        // Two holes meeting at one vertex chain into a figure eight: peel off
        // the loop the walk just closed so each hole gets its own face.
        const peeled = ring.splice(seen);
        for (const vert of peeled) position.delete(vert.id);
        loops.push({ verts: peeled, closed: true });
      }
      position.set(head.id, ring.length);
      ring.push(head);
    }

    if (ring.length >= 2) loops.push({ verts: ring, closed });
  }

  return loops;
}

/**
 * Gives a face to each empty region the selection runs all the way round.
 *
 * The regions come from the mesh's open edges, bordering a face or loose, so
 * an edge with a face on both sides sits out: with the whole mesh selected,
 * only the holes fill, one face for each part a loose edge divides a hole
 * into. The mesh's own outline closes around nothing and stays open.
 *
 * With `fromFaces`, the edges are those of the selected faces. A loose edge
 * across a hole belongs to no face, so it divides the hole without having to
 * be selected. Otherwise, when no region fills and every selected edge is
 * open, a run of them that does not close gets a face across its two ends.
 * Only then: inside a bigger selection, a loose line stopped short on a face
 * would lay a stray face over it.
 *
 * A selected face folded flat back over the faces around it covers no hole,
 * but it puts a second face on the edges of the holes it runs round, and to
 * the walk they would look closed. The walk looks past it, and the fill
 * replaces it wherever it was in a hole's way. One in the way of none stays.
 */
export function fillHole(
  mesh: BMesh,
  edges: readonly Edge[],
  { fromFaces = false }: { fromFaces?: boolean } = {},
): Face[] {
  const selected = new Set(edges);
  const folded = foldedOver(mesh, selected);
  const inTheWay = new Set<Face>();
  const created: Face[] = [];
  const make = (ring: Vert[]) => {
    const face = mesh.addFace(ring);
    face.selected = true;
    created.push(face);
  };

  for (const region of emptyRegions(mesh, folded)) {
    const rim = region.edges.filter(
      (edge) => !fromFaces || edge.loops.some((loop) => !folded.has(loop.face)),
    );
    if (rim.length === 0 || !rim.every((edge) => selected.has(edge))) continue;
    const existing = mesh.findFace(region.verts);
    if (existing && !folded.has(existing)) continue;
    make(region.verts);
    for (const edge of region.edges) {
      for (const loop of edge.loops) if (folded.has(loop.face)) inTheWay.add(loop.face);
    }
  }
  for (const face of inTheWay) mesh.removeFace(face);

  if (created.length === 0 && !fromFaces && edges.every((edge) => edge.loops.length < 2)) {
    for (const { verts, closed } of edgeLoopsFrom(mesh, edges)) {
      if (closed || verts.length < 3 || mesh.findFace(verts)) continue;
      make(orientAgainstNeighbours(mesh, verts));
    }
  }

  mesh.computeNormals();
  return created;
}

/** How nearly opposite two faces must face to count as lying back to back. */
const BACK_TO_BACK = -0.99;

/**
 * Selected faces folded flat back over the faces around them, the way a fill
 * that ran round a sheet's whole outline used to leave one.
 *
 * Such a face lies back to back with a face on every one of its edges, on the
 * same side of the edge. It has to fold onto at least two different faces:
 * the two halves of a double-sided card fold onto each other alone, and a
 * face of the surface under a fold folds onto the fold alone.
 */
function foldedOver(mesh: BMesh, selected: ReadonlySet<Edge>): Set<Face> {
  const normals = new Map<Face, Vec3>();
  const normalOf = (face: Face) => {
    let normal = normals.get(face);
    if (!normal) {
      normal = polygonNormal(mesh.facePoints(face));
      normals.set(face, normal);
    }
    return normal;
  };
  // A face lies to the left of each of its edges, walked its own way round.
  const inward = (loop: Loop) => cross(normalOf(loop.face), sub(loop.next.vert.co, loop.vert.co));

  const folded = new Set<Face>();
  for (const face of mesh.faces.values()) {
    const loops = mesh.faceLoops(face);
    if (!loops.every((loop) => selected.has(loop.edge))) continue;
    const under = new Set<Face>();
    const everywhere = loops.every((loop) => {
      let found = false;
      for (const other of loop.edge.loops) {
        if (other.face === face) continue;
        if (dot(normalOf(face), normalOf(other.face)) > BACK_TO_BACK) continue;
        if (dot(inward(loop), inward(other)) <= 0) continue;
        under.add(other.face);
        found = true;
      }
      return found;
    });
    if (everywhere && under.size > 1) folded.add(face);
  }
  return folded;
}

interface Region {
  /** Wound the way a face filling the region turns, agreeing with the faces around it. */
  verts: Vert[];
  edges: Edge[];
}

/**
 * Traces the regions the open edges close around, each one once.
 *
 * Every open edge has a side no face covers, both sides when it is loose. The
 * walk keeps that side on its left, and where several open edges meet it takes
 * the first one clockwise from the edge it came in on. That is what keeps it
 * to the smallest region: taking whichever edge comes first strings parts of
 * different regions into one ring. The `ignored` faces count as not there.
 */
function emptyRegions(mesh: BMesh, ignored: ReadonlySet<Face>): Region[] {
  const network = openNetwork(mesh, ignored);
  const normals = turningNormals(mesh, network, ignored);
  const uncovered = (edge: Edge, from: Vert) =>
    edge.loops.every((loop) => loop.vert !== from || ignored.has(loop.face));
  const key = (edge: Edge, from: Vert) => edge.id * 2 + (from === edge.v0 ? 0 : 1);
  const walked = new Set<number>();
  const regions: Region[] = [];

  const turn = (edge: Edge, from: Vert, at: Vert): Edge | null => {
    const normal = normals.get(at.id) as Vec3;
    const back = flatten(sub(from.co, at.co), normal);
    let best: Edge | null = null;
    let bestAngle = -1;
    for (const candidate of network.get(at.id) ?? []) {
      if (candidate === edge || !uncovered(candidate, at)) continue;
      const out = flatten(sub(mesh.edgeOther(candidate, at).co, at.co), normal);
      let angle = Math.atan2(dot(normal, cross(back, out)), dot(back, out));
      if (angle < 0) angle += 2 * Math.PI;
      if (angle > bestAngle) {
        best = candidate;
        bestAngle = angle;
      }
    }
    return best;
  };

  for (const [id, around] of network) {
    for (const start of around) {
      const first = mesh.verts.get(id) as Vert;
      if (!uncovered(start, first) || walked.has(key(start, first))) continue;

      const verts: Vert[] = [];
      const edges: Edge[] = [];
      let edge = start;
      let from = first;
      let complete = false;
      for (;;) {
        walked.add(key(edge, from));
        verts.push(from);
        edges.push(edge);
        const at = mesh.edgeOther(edge, from);
        const next = turn(edge, from, at);
        if (!next) break;
        edge = next;
        from = at;
        if (edge === start && from === first) {
          complete = true;
          break;
        }
        if (walked.has(key(edge, from))) break;
      }

      if (!complete || verts.length < 3) continue;
      // A loose edge joining two rings is walked once each way, which a face
      // cannot do.
      if (new Set(verts).size < verts.length) continue;
      const facing = polygonNormal(verts.map((vert) => vert.co));
      if (lengthSq(facing) === 0) continue;
      // The outline of an open sheet winds against the faces along it, where a
      // hole winds with them. Around the rim of a tube they stand square to it.
      const agreement =
        verts.reduce((sum, vert) => sum + dot(facing, normals.get(vert.id) as Vec3), 0) /
        verts.length;
      if (agreement < -0.5) continue;
      regions.push({ verts, edges });
    }
  }

  return regions;
}

/**
 * The open edges at each vertex, less the loose lines that lead nowhere.
 *
 * A knife line stopped inside a face is one: walked out along it and back, it
 * would bend the ring of the region it pokes into back on itself.
 */
function openNetwork(mesh: BMesh, ignored: ReadonlySet<Face>): Map<number, Edge[]> {
  const network = new Map<number, Edge[]>();
  for (const edge of mesh.edges.values()) {
    if (edge.loops.filter((loop) => !ignored.has(loop.face)).length > 1) continue;
    for (const vert of [edge.v0, edge.v1]) {
      const around = network.get(vert.id);
      if (around) around.push(edge);
      else network.set(vert.id, [edge]);
    }
  }

  const ends = [...network.keys()].filter((id) => network.get(id)?.length === 1);
  while (ends.length > 0) {
    const id = ends.pop() as number;
    const around = network.get(id);
    if (around?.length !== 1) continue;
    const [edge] = around;
    network.delete(id);
    const other = edge.v0.id === id ? edge.v1 : edge.v0;
    const rest = (network.get(other.id) ?? []).filter((each) => each !== edge);
    if (rest.length === 0) network.delete(other.id);
    else network.set(other.id, rest);
    if (rest.length === 1) ends.push(other.id);
  }
  return network;
}

/**
 * The plane each vertex of the network turns in, facing the way its faces do.
 *
 * A vertex with only loose edges has no faces to ask, and borrows from the
 * nearest vertices that have. A loose network with no face anywhere along it
 * turns in a plane through its own vertices: which side that plane faces does
 * not matter, as long as the whole network shares it.
 */
function turningNormals(
  mesh: BMesh,
  network: Map<number, Edge[]>,
  ignored: ReadonlySet<Face>,
): Map<number, Vec3> {
  const normals = new Map<number, Vec3>();
  const queue: Vert[] = [];
  for (const id of network.keys()) {
    const vert = mesh.verts.get(id) as Vert;
    const faces = mesh.vertFaces(vert).filter((face) => !ignored.has(face));
    if (faces.length === 0) continue;
    normals.set(
      id,
      normalize(
        faces.reduce((sum, face) => add(sum, polygonNormal(mesh.facePoints(face))), vec3()),
      ),
    );
    queue.push(vert);
  }

  const borrowed = new Map<number, Vec3>();
  for (let i = 0; i < queue.length; i++) {
    const vert = queue[i];
    const own = normals.get(vert.id) ?? normalize(borrowed.get(vert.id) ?? vec3());
    if (lengthSq(own) === 0) continue;
    normals.set(vert.id, own);
    for (const edge of network.get(vert.id) ?? []) {
      const other = mesh.edgeOther(edge, vert);
      if (normals.has(other.id)) continue;
      if (!borrowed.has(other.id)) queue.push(other);
      borrowed.set(other.id, add(borrowed.get(other.id) ?? vec3(), own));
    }
  }

  for (const id of network.keys()) {
    if (normals.has(id)) continue;
    const component = [mesh.verts.get(id) as Vert];
    const reached = new Set([id]);
    for (let i = 0; i < component.length; i++) {
      for (const edge of network.get(component[i].id) ?? []) {
        const other = mesh.edgeOther(edge, component[i]);
        if (reached.has(other.id)) continue;
        reached.add(other.id);
        component.push(other);
      }
    }
    const plane = polygonNormal([...component].sort((a, b) => a.id - b.id).map((vert) => vert.co));
    for (const vert of component) {
      if (!normals.has(vert.id)) normals.set(vert.id, lengthSq(plane) > 0 ? plane : vec3(0, 1, 0));
    }
  }
  return normals;
}

function flatten(direction: Vec3, normal: Vec3): Vec3 {
  return sub(direction, mul(normal, dot(direction, normal)));
}

/**
 * Bridges two edge loops with a band of quads.
 *
 * The second loop is rotated so its start is nearest the first loop's start,
 * and reversed if that produces less twisting: without it, bridging two rings
 * built in opposite directions folds the band over itself.
 */
export function bridgeEdgeLoops(mesh: BMesh, edges: readonly Edge[]): Face[] {
  const loops = edgeLoopsFrom(mesh, edges).map((loop) => loop.verts);
  if (loops.length !== 2) return [];

  const [first, second] = loops;
  if (first.length !== second.length || first.length < 2) return [];

  const aligned = alignRing(first, second);
  const created: Face[] = [];

  for (let i = 0; i < first.length; i++) {
    const next = (i + 1) % first.length;
    const ring = [first[i], first[next], aligned[next], aligned[i]];
    if (new Set(ring.map((vert) => vert.id)).size < 3) continue;
    const face = mesh.addFace(ring);
    face.selected = true;
    created.push(face);
  }

  mesh.computeNormals();
  return created;
}

function alignRing(reference: readonly Vert[], candidate: readonly Vert[]): Vert[] {
  const rotations: Vert[][] = [];
  for (const source of [candidate, [...candidate].reverse()]) {
    for (let offset = 0; offset < source.length; offset++) {
      rotations.push([...source.slice(offset), ...source.slice(0, offset)]);
    }
  }

  let best = rotations[0];
  let bestCost = Infinity;
  for (const rotation of rotations) {
    let cost = 0;
    for (let i = 0; i < reference.length; i++) cost += distanceSq(reference[i].co, rotation[i].co);
    if (cost < bestCost) {
      bestCost = cost;
      best = rotation;
    }
  }
  return best;
}

/**
 * Winds a new face against the boundary it fills, so its normal agrees with the
 * surrounding surface rather than pointing into it.
 */
function orientAgainstNeighbours(mesh: BMesh, ring: readonly Vert[]): Vert[] {
  for (let i = 0; i < ring.length; i++) {
    const from = ring[i];
    const to = ring[(i + 1) % ring.length];
    const edge = mesh.findEdge(from, to);
    const loop = edge?.loops[0];
    if (!loop) continue;
    // A manifold neighbour traverses the shared edge the other way round.
    return loop.vert === from ? [...ring].reverse() : [...ring];
  }
  return [...ring];
}
