import {
  type BMesh,
  type Edge,
  type Face,
  type Loop,
  type Vec3,
  triangulatePolygon,
} from '@kernel/index';

export interface SolidBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /**
   * Per triangle corner: which corner of its triangle it is (0 to 2), plus four
   * times a code. Its low three bits say which of the triangle's sides are edges
   * of its face rather than diagonals the triangulation drew, bit k for the side
   * facing corner k. Above them, two bits for each of the first two diagonals,
   * in that order: whether the triangle across it has an edge of the face from
   * the diagonal's first end to its far corner, and from there to the second
   * end. The dot occlusion pass reads it to find where a face ends (see
   * `createDotOcclusionMaterial`). Empty unless built with `FaceEnds`.
   */
  triangleCorners: Float32Array;
  /**
   * Per triangle corner, the far corner across each of the first two diagonals
   * of its triangle: the corner of the face the triangle across it stands on.
   * Zero where there is none. Three floats a corner, for the first diagonal
   * alone, unless the mesh has a face of five corners or more, the only kind
   * that cuts a triangle with two; then six. Empty unless built with `'far'`.
   */
  farCorners: Float32Array;
  /** Face id behind each triangle, so a raycast hit maps back to the kernel. */
  triangleFaceIds: Int32Array;
  /** Material groups for the Three.js multi-material draw. */
  groups: { start: number; count: number; materialIndex: number }[];
  selectedTriangles: Float32Array;
}

/**
 * A set of edges as the line shaders draw them: both ends of each, and the
 * normals of the faces on either side of it (see `writeSides`).
 */
export interface EdgeLines {
  positions: Float32Array;
  sides: Float32Array;
}

export const NO_EDGE_LINES: EdgeLines = {
  positions: new Float32Array(0),
  sides: new Float32Array(0),
};

export interface EdgeBuffers {
  positions: Float32Array;
  /** The face normals either side of each edge in `positions`; see `writeSides`. */
  sides: Float32Array;
  edgeIds: Int32Array;
  selected: EdgeLines;
  /**
   * Edges with one end selected and one not, for the fade that says which way
   * a vertex selection reaches. Paired with `partialWeights`.
   */
  partialPositions: Float32Array;
  /** 1 at the selected end of each `partialPositions` segment, 0 at the other. */
  partialWeights: Float32Array;
  /** Edges marked sharp, selected or not. */
  sharp: EdgeLines;
}

export interface PointBuffers {
  positions: Float32Array;
  vertIds: Int32Array;
  /** 1 when the vertex is selected, used to tint the point sprite. */
  selection: Float32Array;
}

export interface MeshBuffers {
  solid: SolidBuffers;
  edges: EdgeBuffers;
  points: PointBuffers;
}

/**
 * How much the solid carries of where its faces end, for the dot occlusion
 * pass: which sides of each triangle are edges of its face (`'edges'`), or that
 * and the far corners across its diagonals (`'far'`). Each costs every rebuild
 * time, and only an object whose vertices are marked has its far corners read.
 */
export type FaceEnds = 'edges' | 'far';

/**
 * Converts a BMesh into the three GPU buffer sets the viewport draws:
 * a triangulated solid, an edge line set, and a vertex point cloud.
 *
 * Triangulation happens only here, at the display boundary: the kernel keeps
 * n-gons throughout.
 */
export function buildMeshBuffers(mesh: BMesh, faceEnds?: FaceEnds): MeshBuffers {
  return {
    solid: buildSolid(mesh, faceEnds),
    edges: buildEdges(mesh),
    points: buildPoints(mesh),
  };
}

/** Refilled per face by `buildSolid`, rather than allocated once per face. */
const scratchLoops: Loop[] = [];
const scratchPoints: Vec3[] = [];

/**
 * Written straight into typed arrays, sized by a counting pass first.
 *
 * The obvious way round, pushing onto plain arrays and converting at the end,
 * costs more than everything else here put together at the sizes a real
 * project reaches: a 98k-face mesh pushes about 2.4 million numbers onto three
 * growing arrays and then copies each into a typed one. Counting the triangles
 * first and filling fixed buffers measured 362 ms against 147 ms on that mesh,
 * and a drag pays this on every pointer move.
 */
function buildSolid(mesh: BMesh, faceEnds?: FaceEnds): SolidBuffers {
  // Faces are visited in material order so each material becomes one draw call.
  const byMaterial = new Map<number, Face[]>();
  let triangles = 0;
  let selectedTriangleCount = 0;
  let ngons = false;
  for (const face of mesh.faces.values()) {
    const bucket = byMaterial.get(face.materialIndex);
    if (bucket) bucket.push(face);
    else byMaterial.set(face.materialIndex, [face]);

    const corners = mesh.faceLoopCount(face);
    const faceTriangles = Math.max(0, corners - 2);
    triangles += faceTriangles;
    if (face.selected) selectedTriangleCount += faceTriangles;
    if (corners > 4) ngons = true;
  }

  const positions = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  const uvs = new Float32Array(triangles * 6);
  const triangleCorners = new Float32Array(faceEnds ? triangles * 3 : 0);
  // Only a face of five corners or more cuts a triangle with two diagonals, so
  // a mesh of quads and triangles holds one far corner a corner, not two.
  const farStride = faceEnds !== 'far' ? 0 : ngons ? 6 : 3;
  const farCorners = new Float32Array(triangles * 3 * farStride);
  const triangleFaceIds = new Int32Array(triangles);
  const selectedTriangles = new Float32Array(selectedTriangleCount * 9);

  // Empty on a mesh with no sharp edges, which is most of them, and then every
  // smooth corner reads its vertex normal below.
  const splitNormals = mesh.cornerNormals();

  const groups: SolidBuffers['groups'] = [];
  let vertex = 0;
  let uv = 0;
  let triangle = 0;
  let selected = 0;

  for (const [materialIndex, faces] of [...byMaterial.entries()].sort((a, b) => a[0] - b[0])) {
    const start = vertex / 3;

    for (const face of faces) {
      // Walked into scratch rather than collected: `faceLoops` and a `map` over
      // it are two arrays per face, and a dense mesh has a hundred thousand of
      // them to get through on every pointer move of a drag.
      let corners = 0;
      let loop = face.loop;
      do {
        scratchLoops[corners] = loop;
        scratchPoints[corners] = loop.vert.co;
        corners++;
        loop = loop.next;
      } while (loop !== face.loop && corners < 4096);
      scratchLoops.length = corners;
      scratchPoints.length = corners;

      const loops = scratchLoops;
      const indices = triangulatePolygon(scratchPoints, face.normal);
      const across = farStride > 0 ? acrossDiagonals(indices, corners) : null;

      for (let i = 0; i < indices.length; i += 3) {
        triangleFaceIds[triangle++] = face.id;

        // Which sides are edges of the face, and across the first two that are
        // diagonals, the far corner and which sides out to it are edges, as
        // `triangleCorners` and `farCorners` hold them.
        let code = 0;
        let diagonal = 0;
        for (let k = 0; faceEnds && k < 3; k++) {
          const first = indices[i + ((k + 1) % 3)];
          const second = indices[i + ((k + 2) % 3)];
          if (isFaceEdge(first, second, corners)) {
            code |= 1 << k;
            continue;
          }
          const far = across ? across[i + k] : -1;
          if (diagonal * 3 < farStride && far >= 0) {
            const edges =
              (isFaceEdge(first, far, corners) ? 1 : 0) |
              (isFaceEdge(far, second, corners) ? 2 : 0);
            code |= edges << (3 + 2 * diagonal);
            const co = loops[far].vert.co;
            const from = (vertex / 3) * farStride + diagonal * 3;
            for (let at = from; at < from + 3 * farStride; at += farStride) {
              farCorners[at] = co.x;
              farCorners[at + 1] = co.y;
              farCorners[at + 2] = co.z;
            }
          }
          diagonal++;
        }

        for (let corner = 0; corner < 3; corner++) {
          if (faceEnds) triangleCorners[vertex / 3] = corner + 4 * code;
          const loop = loops[indices[i + corner]];
          const normal = face.smooth
            ? (splitNormals.get(loop.id) ?? loop.vert.normal)
            : face.normal;
          const co = loop.vert.co;

          positions[vertex] = co.x;
          positions[vertex + 1] = co.y;
          positions[vertex + 2] = co.z;
          normals[vertex] = normal.x;
          normals[vertex + 1] = normal.y;
          normals[vertex + 2] = normal.z;
          uvs[uv] = loop.uv.u;
          uvs[uv + 1] = loop.uv.v;

          if (face.selected) {
            selectedTriangles[selected] = co.x;
            selectedTriangles[selected + 1] = co.y;
            selectedTriangles[selected + 2] = co.z;
            selected += 3;
          }

          vertex += 3;
          uv += 2;
        }
      }
    }

    const count = vertex / 3 - start;
    if (count > 0) groups.push({ start, count, materialIndex });
  }

  return {
    positions,
    normals,
    uvs,
    triangleCorners,
    farCorners,
    triangleFaceIds,
    groups,
    selectedTriangles,
  };
}

/**
 * Whether corners `p` and `q` of a face of `count` corners are joined by one of
 * its edges, being next to each other round it, rather than by a diagonal.
 */
function isFaceEdge(p: number, q: number, count: number): boolean {
  const apart = Math.abs(p - q);
  return apart === 1 || apart === count - 1;
}

/** Where in `indices` the corner of one triangle is that the other one lacks. */
function offDiagonal(indices: readonly number[], triangle: number, other: number): number {
  for (let k = triangle; k < triangle + 3; k++) {
    const corner = indices[k];
    if (
      corner !== indices[other] &&
      corner !== indices[other + 1] &&
      corner !== indices[other + 2]
    ) {
      return k;
    }
  }
  return -1;
}

/** Refilled per face by `acrossDiagonals`, rather than allocated once per face. */
const scratchAcross: number[] = [];
const scratchDiagonals = new Map<number, number>();

/**
 * For each diagonal among the sides of the triangles `indices` cuts a face of
 * `count` corners into, at the position of the corner the side faces: the
 * face's corner across it, the third corner of the other triangle standing on
 * it, or -1 if none does. What it holds for an edge of the face is left over
 * from an earlier face, since nothing asks.
 */
function acrossDiagonals(indices: readonly number[], count: number): number[] {
  const across = scratchAcross;
  if (count < 4) return across;

  // A quad is two triangles on one diagonal. The corner of each that is off it
  // faces it, and is the far corner for the other. Most faces are quads, and
  // this spares them the general walk below.
  if (count === 4 && indices.length === 6) {
    const first = offDiagonal(indices, 0, 3);
    const second = offDiagonal(indices, 3, 0);
    for (let i = 0; i < 6; i++) across[i] = -1;
    if (first >= 0 && second >= 0) {
      across[first] = indices[second];
      across[second] = indices[first];
    }
    return across;
  }

  across.length = indices.length;
  across.fill(-1);

  // Where each diagonal was first seen, by its two corners.
  const seen = scratchDiagonals;
  seen.clear();
  for (let i = 0; i < indices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const p = indices[i + ((k + 1) % 3)];
      const q = indices[i + ((k + 2) % 3)];
      if (isFaceEdge(p, q, count)) continue;

      const key = Math.min(p, q) * count + Math.max(p, q);
      const other = seen.get(key);
      if (other === undefined) {
        seen.set(key, i + k);
      } else {
        across[i + k] = indices[other];
        across[other] = indices[i + k];
      }
    }
  }
  return across;
}

function buildEdges(mesh: BMesh): EdgeBuffers {
  // Counted first so every buffer below is filled rather than grown, for the
  // reason `buildSolid` gives.
  let selectedCount = 0;
  let partialCount = 0;
  let sharpCount = 0;
  for (const edge of mesh.edges.values()) {
    if (edge.sharp) sharpCount++;
    if (edge.selected) selectedCount++;
    else if (edge.v0.selected !== edge.v1.selected) partialCount++;
  }

  const positions = new Float32Array(mesh.edges.size * 6);
  const sides = new Float32Array(mesh.edges.size * 6);
  const edgeIds = new Int32Array(mesh.edges.size);
  const selectedPositions = new Float32Array(selectedCount * 6);
  const selectedSides = new Float32Array(selectedCount * 6);
  const partialPositions = new Float32Array(partialCount * 6);
  const partialWeights = new Float32Array(partialCount * 2);
  const sharpPositions = new Float32Array(sharpCount * 6);
  const sharpSides = new Float32Array(sharpCount * 6);

  let e = 0;
  let selected = 0;
  let partial = 0;
  let weight = 0;
  let sharp = 0;

  for (const edge of mesh.edges.values()) {
    const a = edge.v0.co;
    const b = edge.v1.co;
    const at = e * 6;
    positions[at] = a.x;
    positions[at + 1] = a.y;
    positions[at + 2] = a.z;
    positions[at + 3] = b.x;
    positions[at + 4] = b.y;
    positions[at + 5] = b.z;
    writeSides(sides, at, edge);
    edgeIds[e] = edge.id;
    e++;

    if (edge.sharp) {
      sharpPositions[sharp] = a.x;
      sharpPositions[sharp + 1] = a.y;
      sharpPositions[sharp + 2] = a.z;
      sharpPositions[sharp + 3] = b.x;
      sharpPositions[sharp + 4] = b.y;
      sharpPositions[sharp + 5] = b.z;
      writeSides(sharpSides, sharp, edge);
      sharp += 6;
    }

    if (edge.selected) {
      selectedPositions[selected] = a.x;
      selectedPositions[selected + 1] = a.y;
      selectedPositions[selected + 2] = a.z;
      selectedPositions[selected + 3] = b.x;
      selectedPositions[selected + 4] = b.y;
      selectedPositions[selected + 5] = b.z;
      writeSides(selectedSides, selected, edge);
      selected += 6;
      continue;
    }

    // One end selected and one not, rather than any end at all: an unselected
    // edge running between two selected ones carries a selected vertex at each
    // end once the selection is flushed, and a fade reading full at both would
    // draw it as though it were selected itself.
    if (edge.v0.selected !== edge.v1.selected) {
      partialPositions[partial] = a.x;
      partialPositions[partial + 1] = a.y;
      partialPositions[partial + 2] = a.z;
      partialPositions[partial + 3] = b.x;
      partialPositions[partial + 4] = b.y;
      partialPositions[partial + 5] = b.z;
      partial += 6;
      partialWeights[weight] = edge.v0.selected ? 1 : 0;
      partialWeights[weight + 1] = edge.v1.selected ? 1 : 0;
      weight += 2;
    }
  }

  return {
    positions,
    sides,
    edgeIds,
    selected: { positions: selectedPositions, sides: selectedSides },
    partialPositions,
    partialWeights,
    sharp: { positions: sharpPositions, sides: sharpSides },
  };
}

/**
 * Writes the normals of the faces either side of an edge, six floats from
 * `at`, for the wire's lift to size itself by (see `liftWire`).
 *
 * A boundary repeats its one face, and a bare wire edge is left at zero, which
 * the shader reads as nothing under the line to clear. A non-manifold edge
 * gives its first two faces.
 */
function writeSides(target: Float32Array, at: number, edge: Edge): void {
  const { loops } = edge;
  if (loops.length === 0) return;

  const a = loops[0].face.normal;
  const b = loops[loops.length > 1 ? 1 : 0].face.normal;
  target[at] = a.x;
  target[at + 1] = a.y;
  target[at + 2] = a.z;
  target[at + 3] = b.x;
  target[at + 4] = b.y;
  target[at + 5] = b.z;
}

/**
 * Whether a face is turned towards the camera, answered once per face.
 *
 * `eye` is the camera in the mesh's own space. Testing there rather than in
 * world space is not an approximation: for any invertible transform the sign of
 * `normal · (eye - centre)` is the same on both sides of it, so the answer is
 * exact and no face has to be transformed to get it.
 */
function cameraFacing(mesh: BMesh, eye: Vec3): (face: Face) => boolean {
  // One test per face rather than one per edge-side: every face is shared.
  const facing = new Map<number, boolean>();

  return (face: Face): boolean => {
    const cached = facing.get(face.id);
    if (cached !== undefined) return cached;

    const centre = mesh.faceCenter(face);
    const towards =
      face.normal.x * (eye.x - centre.x) +
      face.normal.y * (eye.y - centre.y) +
      face.normal.z * (eye.z - centre.z);
    facing.set(face.id, towards > 0);
    return towards > 0;
  };
}

/**
 * Everything `frontEdgeLines` needs, flattened out of the half-edge graph.
 *
 * The pass that uses this runs on every frame the camera moves, and walking the
 * mesh itself there costs far more than the answer is worth: a map lookup per
 * face, a vector allocated per centre, a loop chased per edge. Measured on a
 * 49k-edge sphere that was 17 ms a frame, against 1 ms for the same work over
 * these arrays. Nothing in here changes until the mesh does, so it is built
 * once and read many times (see `ObjectView`).
 */
export interface EdgeCull {
  /** Both endpoints of every edge, in the order `buildEdges` writes them. */
  ends: Float32Array;
  /** The face normals either side of every edge, as `writeSides` gives them. */
  sideNormals: Float32Array;
  /**
   * The two faces along each edge, as indices into the face tables.
   *
   * Either slot is -1 when the edge has some number of faces other than two: a
   * boundary, a bare wire, or the fan of a non-manifold join. None of those has
   * a far side to be on, so a -1 is what keeps them always drawn.
   */
  sides: Int32Array;
  normals: Float32Array;
  centres: Float32Array;
  /** Which faces are turned towards the camera, rewritten by each pass. */
  facing: Uint8Array;
  /**
   * Whether every edge of the mesh has exactly two faces.
   *
   * What hides a face turned away is the rest of the mesh standing between it
   * and the camera, and only a closed surface promises that much. Cut a box in
   * half and the inside of its walls is what the user is looking at.
   */
  closed: boolean;
  /** The mesh's extent in its own space, as `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  bounds: Float32Array;
  /** Every face's corners, face after face, for `encloses`. */
  corners: Float32Array;
  /** Where each face starts in `corners`, counted in corners, and one past the last. */
  faceStarts: Uint32Array;
  /** The sharp edges, as indices into `ends` and `sides`. */
  sharp: Int32Array;
  /** Both ends of every edge, as indices into the point buffer `buildPoints` writes. */
  edgeVerts: Uint32Array;
  vertCount: number;
  /** The vertices with no edge at all, which have no side to be on. */
  looseVerts: Uint32Array;
}

export function buildEdgeCull(mesh: BMesh): EdgeCull {
  const normals = new Float32Array(mesh.faces.size * 3);
  const centres = new Float32Array(mesh.faces.size * 3);
  const indexOfFace = new Map<number, number>();

  // In the order `buildPoints` walks them, which is what the dots are drawn in.
  const indexOfVert = new Map<number, number>();
  const looseVerts: number[] = [];
  for (const vert of mesh.verts.values()) {
    if (vert.edges.length === 0) looseVerts.push(indexOfVert.size);
    indexOfVert.set(vert.id, indexOfVert.size);
  }

  let cornerCount = 0;
  for (const face of mesh.faces.values()) cornerCount += mesh.faceLoopCount(face);
  const faceCorners = new Float32Array(cornerCount * 3);
  const faceStarts = new Uint32Array(mesh.faces.size + 1);

  let f = 0;
  let c = 0;
  for (const face of mesh.faces.values()) {
    // The centre is averaged in place: `faceCenter` allocates a vector per
    // face, and a drag rebuilds this on every pointer move.
    let x = 0;
    let y = 0;
    let z = 0;
    let corners = 0;
    let loop = face.loop;
    do {
      x += loop.vert.co.x;
      y += loop.vert.co.y;
      z += loop.vert.co.z;
      faceCorners[c * 3] = loop.vert.co.x;
      faceCorners[c * 3 + 1] = loop.vert.co.y;
      faceCorners[c * 3 + 2] = loop.vert.co.z;
      c++;
      corners++;
      loop = loop.next;
    } while (loop !== face.loop && corners < 4096);

    normals[f * 3] = face.normal.x;
    normals[f * 3 + 1] = face.normal.y;
    normals[f * 3 + 2] = face.normal.z;
    centres[f * 3] = x / corners;
    centres[f * 3 + 1] = y / corners;
    centres[f * 3 + 2] = z / corners;
    indexOfFace.set(face.id, f);
    f++;
    faceStarts[f] = c;
  }

  const ends = new Float32Array(mesh.edges.size * 6);
  const sideNormals = new Float32Array(mesh.edges.size * 6);
  const sides = new Int32Array(mesh.edges.size * 2).fill(-1);
  const edgeVerts = new Uint32Array(mesh.edges.size * 2);
  const bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const sharp: number[] = [];
  let closed = mesh.faces.size > 0;

  let e = 0;
  for (const edge of mesh.edges.values()) {
    if (edge.sharp) sharp.push(e);
    edgeVerts[e * 2] = indexOfVert.get(edge.v0.id) ?? 0;
    edgeVerts[e * 2 + 1] = indexOfVert.get(edge.v1.id) ?? 0;
    ends[e * 6] = edge.v0.co.x;
    ends[e * 6 + 1] = edge.v0.co.y;
    ends[e * 6 + 2] = edge.v0.co.z;
    ends[e * 6 + 3] = edge.v1.co.x;
    ends[e * 6 + 4] = edge.v1.co.y;
    ends[e * 6 + 5] = edge.v1.co.z;
    writeSides(sideNormals, e * 6, edge);

    for (let axis = 0; axis < 3; axis++) {
      const a = ends[e * 6 + axis];
      const b = ends[e * 6 + 3 + axis];
      bounds[axis] = Math.min(bounds[axis], a, b);
      bounds[axis + 3] = Math.max(bounds[axis + 3], a, b);
    }

    if (edge.loops.length === 2) {
      sides[e * 2] = indexOfFace.get(edge.loops[0].face.id) ?? -1;
      sides[e * 2 + 1] = indexOfFace.get(edge.loops[1].face.id) ?? -1;
    } else {
      closed = false;
    }
    e++;
  }

  return {
    ends,
    sideNormals,
    sides,
    normals,
    centres,
    facing: new Uint8Array(mesh.faces.size),
    closed,
    bounds,
    corners: faceCorners,
    faceStarts,
    sharp: Int32Array.from(sharp),
    edgeVerts,
    vertCount: mesh.verts.size,
    looseVerts: Uint32Array.from(looseVerts),
  };
}

/**
 * Whether the camera stands inside the mesh's extent.
 *
 * A camera outside the box around a closed mesh is outside the mesh itself,
 * which is the whole of what the far-side cull needs to know, and the box
 * answers that for next to nothing. Inside the box `encloses` has to settle it.
 */
function withinBounds(bounds: Float32Array, eye: Vec3): boolean {
  return (
    eye.x >= bounds[0] &&
    eye.y >= bounds[1] &&
    eye.z >= bounds[2] &&
    eye.x <= bounds[3] &&
    eye.y <= bounds[4] &&
    eye.z <= bounds[5]
  );
}

/**
 * Whether the camera stands inside a closed mesh, by the mesh's winding number
 * about the eye.
 *
 * Inside, every face the camera can see is turned away from it: standing in a
 * room modelled as a cube, the cull would take the wireframe off the walls
 * being looked at. The bounding box alone used to stand in for this, and it
 * says inside far too often. A close-up between the arms of a fork, or in the
 * gap between two parts of one mesh, is inside the box and out in the open, and
 * the cull standing down there let the far side's edges back through the depth
 * test as ticks off every corner of the near side.
 *
 * Each face is summed as a fan from its first corner, as the solid angle it
 * covers from the eye, signed by which way it is turned. Over a closed surface
 * that comes to a whole sphere from inside and to nothing from outside, whatever
 * shape the surface is and however its faces are cut, which is why the test
 * asks only which of the two it is nearer.
 */
function encloses(cull: EdgeCull, eye: Vec3): boolean {
  const { corners, faceStarts } = cull;
  let solidAngle = 0;

  for (let f = 0; f + 1 < faceStarts.length; f++) {
    const first = faceStarts[f] * 3;
    const end = faceStarts[f + 1] * 3;
    const ax = corners[first] - eye.x;
    const ay = corners[first + 1] - eye.y;
    const az = corners[first + 2] - eye.z;
    const al = Math.sqrt(ax * ax + ay * ay + az * az);

    for (let at = first + 3; at + 3 < end; at += 3) {
      const bx = corners[at] - eye.x;
      const by = corners[at + 1] - eye.y;
      const bz = corners[at + 2] - eye.z;
      const cx = corners[at + 3] - eye.x;
      const cy = corners[at + 4] - eye.y;
      const cz = corners[at + 5] - eye.z;
      const bl = Math.sqrt(bx * bx + by * by + bz * bz);
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);

      // Van Oosterom and Strackee: the angle here is half the triangle's solid angle.
      const volume = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
      const spread =
        al * bl * cl +
        (ax * bx + ay * by + az * bz) * cl +
        (bx * cx + by * cy + bz * cz) * al +
        (cx * ax + cy * ay + cz * az) * bl;
      solidAngle += 2 * Math.atan2(volume, spread);
    }
  }

  return Math.abs(solidAngle) > 2 * Math.PI;
}

/**
 * Records in `cull.facing` which faces are turned towards the camera, or says
 * the cull does not hold from here (see `frontEdgeLines`).
 */
function faceCamera(cull: EdgeCull, eye: Vec3): boolean {
  const { normals, centres, facing, closed, bounds } = cull;
  if (!closed || (withinBounds(bounds, eye) && encloses(cull, eye))) return false;

  for (let f = 0; f < facing.length; f++) {
    const towards =
      normals[f * 3] * (eye.x - centres[f * 3]) +
      normals[f * 3 + 1] * (eye.y - centres[f * 3 + 1]) +
      normals[f * 3 + 2] * (eye.z - centres[f * 3 + 2]);
    facing[f] = towards > 0 ? 1 : 0;
  }
  return true;
}

/** Whether an edge has a face towards the camera, or no far side to be on. */
function onNearSide(cull: EdgeCull, edge: number): boolean {
  const a = cull.sides[edge * 2];
  const b = cull.sides[edge * 2 + 1];
  return a < 0 || b < 0 || cull.facing[a] === 1 || cull.facing[b] === 1;
}

/**
 * The edges worth drawing over an opaque surface: everything except the ones
 * lying on the far side of it.
 *
 * An edge whose every face is turned away is behind the model from here, and
 * the depth test is the wrong tool for saying so. Near a contour the far side
 * runs within a pixel of the near one, close enough that rounding lets it
 * through, and it drew as a short second line beside the edge it sits behind or
 * as a stub hanging off a corner. Answering it from the topology instead is
 * exact at any zoom.
 *
 * That answer holds only while the mesh's own surface is what stands in the
 * way, so an open mesh, or a camera inside a closed one, keeps every edge.
 * A box cut in half shows the inside of its walls, and the faces you are
 * looking at there are turned away: culling them left the cut with no lines
 * on the side you can see into. Depth decides in those views, contour rounding
 * and all, which is what it did everywhere before this pass existed.
 *
 * `eye` is the camera in the mesh's own space, for the reason `cameraFacing`
 * gives. Skipped in x-ray and wireframe shading, where seeing through the model
 * is the point (see `ObjectView`).
 */
export function frontEdgeLines(cull: EdgeCull, eye: Vec3): EdgeLines {
  const { ends, sideNormals, sides } = cull;

  if (!faceCamera(cull, eye)) return { positions: ends, sides: sideNormals };

  const edges = sides.length / 2;

  // Counted before it is filled, so the buffer handed on is exactly the size it
  // needs and nothing has to be copied out of a larger one afterwards.
  let kept = 0;
  for (let edge = 0; edge < edges; edge++) if (onNearSide(cull, edge)) kept++;

  const lines = { positions: new Float32Array(kept * 6), sides: new Float32Array(kept * 6) };
  let n = 0;
  for (let edge = 0; edge < edges; edge++) {
    if (!onNearSide(cull, edge)) continue;
    copyEdge(cull, edge, lines, n);
    n += 6;
  }

  return lines;
}

/** Copies one edge of the cull table into a line set, six floats from `at`. */
function copyEdge(cull: EdgeCull, edge: number, lines: EdgeLines, at: number): void {
  const from = edge * 6;
  for (let i = 0; i < 6; i++) {
    lines.positions[at + i] = cull.ends[from + i];
    lines.sides[at + i] = cull.sideNormals[from + i];
  }
}

/**
 * The sharp edges worth drawing over an opaque surface, left out on the far
 * side the way `frontEdgeLines` leaves out the wireframe.
 *
 * They need it more than the wire does. A far-side edge comes through at a
 * contour as a stub a pixel or two long, which in the faint wire is easy to
 * miss and in cyan is not.
 */
export function frontSharpLines(cull: EdgeCull, eye: Vec3): EdgeLines {
  const { sharp } = cull;
  if (sharp.length === 0) return NO_EDGE_LINES;

  const culls = faceCamera(cull, eye);
  let kept = 0;
  for (const edge of sharp) if (!culls || onNearSide(cull, edge)) kept++;

  const lines = { positions: new Float32Array(kept * 6), sides: new Float32Array(kept * 6) };
  let n = 0;
  for (const edge of sharp) {
    if (culls && !onNearSide(cull, edge)) continue;
    copyEdge(cull, edge, lines, n);
    n += 6;
  }

  return lines;
}

/**
 * Which vertex dots are worth drawing over an opaque surface, as 1 or 0 per
 * point in `buildPoints` order, or null to draw every one.
 *
 * A vertex is on the far side when every face round it is, which is when no
 * edge of it is on the near one. The depth test fails the dots there for the
 * reason it fails the wire: near a contour the far side runs within a dot's
 * lift of the near one. Zoomed out, a whole model can be that thin in depth,
 * and its far side came through as a scatter of squares along every contour.
 */
export function frontVerts(cull: EdgeCull, eye: Vec3): Uint8Array | null {
  if (!faceCamera(cull, eye)) return null;

  const front = new Uint8Array(cull.vertCount);
  for (const vert of cull.looseVerts) front[vert] = 1;

  const edges = cull.sides.length / 2;
  for (let edge = 0; edge < edges; edge++) {
    if (!onNearSide(cull, edge)) continue;
    front[cull.edgeVerts[edge * 2]] = 1;
    front[cull.edgeVerts[edge * 2 + 1]] = 1;
  }

  return front;
}

/**
 * The edges that trace a mesh's outline from where the camera stands.
 *
 * An edge is on the silhouette when the two faces sharing it disagree about
 * facing the camera; an edge with anything other than two faces (a boundary,
 * a bare wire) always is, which is what gives flat and open shapes an outline
 * as well as closed ones.
 */
export function buildSilhouetteEdges(mesh: BMesh, eye: Vec3): Float32Array {
  const positions: number[] = [];
  const facesCamera = cameraFacing(mesh, eye);

  for (const edge of mesh.edges.values()) {
    const onOutline =
      edge.loops.length !== 2 ||
      facesCamera(edge.loops[0].face) !== facesCamera(edge.loops[1].face);
    if (!onOutline) continue;

    positions.push(edge.v0.co.x, edge.v0.co.y, edge.v0.co.z);
    positions.push(edge.v1.co.x, edge.v1.co.y, edge.v1.co.z);
  }

  return new Float32Array(positions);
}

function buildPoints(mesh: BMesh): PointBuffers {
  const positions = new Float32Array(mesh.verts.size * 3);
  const vertIds = new Int32Array(mesh.verts.size);
  const selection = new Float32Array(mesh.verts.size);

  let index = 0;
  for (const vert of mesh.verts.values()) {
    positions[index * 3] = vert.co.x;
    positions[index * 3 + 1] = vert.co.y;
    positions[index * 3 + 2] = vert.co.z;
    vertIds[index] = vert.id;
    selection[index] = vert.selected ? 1 : 0;
    index++;
  }

  return { positions, vertIds, selection };
}

/**
 * Lifts a dot for the steepest surface there is: its faces are not known, as
 * for the hover mark, or they cancel out and give no axis to lean about.
 */
export const UNKNOWN_POINT_FACES = [0, 0, 0, Math.PI / 2] as const;

/**
 * The faces round each vertex, as the dot's lift reads them (see
 * `liftPoints`): four floats per point, in `buildPoints` order.
 *
 * The first three are an axis the faces lean about and the fourth is how far
 * the furthest of them leans from it, in radians. However the camera turns, no
 * face round the vertex is turned further from the view than the axis is plus
 * that much, which bounds the steepest surface the dot has to clear. A vertex
 * on a flat stretch spreads by nothing and is lifted for exactly the face it
 * sits on. A corner is lifted for its steepest side.
 *
 * Measured with the object's scale applied, since squashing an object turns
 * its faces' normals further apart than they are in its own space. Rotation
 * keeps every angle as it was and is left to the shader's normal matrix. That
 * matrix divides the scale back out of whatever it is handed, which is why the
 * axis comes back stretched by it.
 *
 * A vertex with no face has nothing to clear and is left at zero.
 *
 * Walks each vertex's faces twice, for the axis and then for the face leaning
 * furthest from it, rather than holding their normals in between. A drag in
 * vertex mode rebuilds this on every pointer move, and the walk is the cheaper
 * of the two.
 */
export function buildPointFaces(mesh: BMesh, scale: Vec3): Float32Array {
  const faces = new Float32Array(mesh.verts.size * 4);
  const inverse = (value: number) => 1 / (Math.abs(value) < 1e-12 ? 1e-12 : value);
  const ix = inverse(scale.x);
  const iy = inverse(scale.y);
  const iz = inverse(scale.z);

  let at = -4;
  for (const vert of mesh.verts.values()) {
    at += 4;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let corners = 0;

    // A face's corner at this vertex is the one loop of it that starts here.
    for (const edge of vert.edges) {
      for (const loop of edge.loops) {
        if (loop.vert !== vert) continue;
        const { normal } = loop.face;
        const x = normal.x * ix;
        const y = normal.y * iy;
        const z = normal.z * iz;
        const length = Math.sqrt(x * x + y * y + z * z);
        if (length === 0) continue;
        sx += x / length;
        sy += y / length;
        sz += z / length;
        corners++;
      }
    }
    if (corners === 0) continue;

    const sum = Math.sqrt(sx * sx + sy * sy + sz * sz);
    const ax = sx / sum;
    const ay = sy / sum;
    const az = sz / sum;
    const ox = ax * scale.x;
    const oy = ay * scale.y;
    const oz = az * scale.z;
    const out = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (!(sum > 1e-6) || !(out > 0)) {
      faces.set(UNKNOWN_POINT_FACES, at);
      continue;
    }

    let least = 1;
    for (const edge of vert.edges) {
      for (const loop of edge.loops) {
        if (loop.vert !== vert) continue;
        const { normal } = loop.face;
        const x = normal.x * ix;
        const y = normal.y * iy;
        const z = normal.z * iz;
        const length = Math.sqrt(x * x + y * y + z * z);
        if (length === 0) continue;
        least = Math.min(least, (ax * x + ay * y + az * z) / length);
      }
    }

    faces[at] = ox / out;
    faces[at + 1] = oy / out;
    faces[at + 2] = oz / out;
    faces[at + 3] = Math.acos(Math.max(-1, Math.min(1, least)));
  }

  return faces;
}

/** Line segments showing each face normal, for the normals overlay. */
export function buildNormalLines(mesh: BMesh, length = 0.2): Float32Array {
  const positions: number[] = [];

  for (const face of mesh.faces.values()) {
    const center = mesh.faceCenter(face);
    positions.push(center.x, center.y, center.z);
    positions.push(
      center.x + face.normal.x * length,
      center.y + face.normal.y * length,
      center.z + face.normal.z * length,
    );
  }

  return new Float32Array(positions);
}
