import { type BMesh, type Face, type Loop, type Vec3, triangulatePolygon } from '@kernel/index';

export interface SolidBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Face id behind each triangle, so a raycast hit maps back to the kernel. */
  triangleFaceIds: Int32Array;
  /** Material groups for the Three.js multi-material draw. */
  groups: { start: number; count: number; materialIndex: number }[];
  selectedTriangles: Float32Array;
}

export interface EdgeBuffers {
  positions: Float32Array;
  edgeIds: Int32Array;
  selectedPositions: Float32Array;
  /**
   * Edges with one end selected and one not, for the fade that says which way
   * a vertex selection reaches. Paired with `partialWeights`.
   */
  partialPositions: Float32Array;
  /** 1 at the selected end of each `partialPositions` segment, 0 at the other. */
  partialWeights: Float32Array;
  /** Edges marked sharp, selected or not. */
  sharpPositions: Float32Array;
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
 * Converts a BMesh into the three GPU buffer sets the viewport draws:
 * a triangulated solid, an edge line set, and a vertex point cloud.
 *
 * Triangulation happens only here, at the display boundary: the kernel keeps
 * n-gons throughout.
 */
export function buildMeshBuffers(mesh: BMesh): MeshBuffers {
  return {
    solid: buildSolid(mesh),
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
function buildSolid(mesh: BMesh): SolidBuffers {
  // Faces are visited in material order so each material becomes one draw call.
  const byMaterial = new Map<number, Face[]>();
  let triangles = 0;
  let selectedTriangleCount = 0;
  for (const face of mesh.faces.values()) {
    const bucket = byMaterial.get(face.materialIndex);
    if (bucket) bucket.push(face);
    else byMaterial.set(face.materialIndex, [face]);

    const corners = mesh.faceLoopCount(face);
    const faceTriangles = Math.max(0, corners - 2);
    triangles += faceTriangles;
    if (face.selected) selectedTriangleCount += faceTriangles;
  }

  const positions = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  const uvs = new Float32Array(triangles * 6);
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

      for (let i = 0; i < indices.length; i += 3) {
        triangleFaceIds[triangle++] = face.id;

        for (let corner = 0; corner < 3; corner++) {
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

  return { positions, normals, uvs, triangleFaceIds, groups, selectedTriangles };
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
  const edgeIds = new Int32Array(mesh.edges.size);
  const selectedPositions = new Float32Array(selectedCount * 6);
  const partialPositions = new Float32Array(partialCount * 6);
  const partialWeights = new Float32Array(partialCount * 2);
  const sharpPositions = new Float32Array(sharpCount * 6);

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
    edgeIds[e] = edge.id;
    e++;

    if (edge.sharp) {
      sharpPositions[sharp] = a.x;
      sharpPositions[sharp + 1] = a.y;
      sharpPositions[sharp + 2] = a.z;
      sharpPositions[sharp + 3] = b.x;
      sharpPositions[sharp + 4] = b.y;
      sharpPositions[sharp + 5] = b.z;
      sharp += 6;
    }

    if (edge.selected) {
      selectedPositions[selected] = a.x;
      selectedPositions[selected + 1] = a.y;
      selectedPositions[selected + 2] = a.z;
      selectedPositions[selected + 3] = b.x;
      selectedPositions[selected + 4] = b.y;
      selectedPositions[selected + 5] = b.z;
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
    edgeIds,
    selectedPositions,
    partialPositions,
    partialWeights,
    sharpPositions,
  };
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
 * Everything `frontEdgePositions` needs, flattened out of the half-edge graph.
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
  /** The sharp edges, as indices into `ends` and `sides`. */
  sharp: Int32Array;
}

export function buildEdgeCull(mesh: BMesh): EdgeCull {
  const normals = new Float32Array(mesh.faces.size * 3);
  const centres = new Float32Array(mesh.faces.size * 3);
  const indexOfFace = new Map<number, number>();

  let f = 0;
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
  }

  const ends = new Float32Array(mesh.edges.size * 6);
  const sides = new Int32Array(mesh.edges.size * 2).fill(-1);
  const bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const sharp: number[] = [];
  let closed = mesh.faces.size > 0;

  let e = 0;
  for (const edge of mesh.edges.values()) {
    if (edge.sharp) sharp.push(e);
    ends[e * 6] = edge.v0.co.x;
    ends[e * 6 + 1] = edge.v0.co.y;
    ends[e * 6 + 2] = edge.v0.co.z;
    ends[e * 6 + 3] = edge.v1.co.x;
    ends[e * 6 + 4] = edge.v1.co.y;
    ends[e * 6 + 5] = edge.v1.co.z;

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
    sides,
    normals,
    centres,
    facing: new Uint8Array(mesh.faces.size),
    closed,
    bounds,
    sharp: Int32Array.from(sharp),
  };
}

/**
 * Whether the camera stands inside the mesh's extent.
 *
 * A camera outside the box around a closed mesh is outside the mesh itself,
 * which is the whole of what the far-side cull needs to know. Inside the box
 * it may well be inside the surface, where every face it can see is turned
 * away: standing in a room modelled as a cube, the cull would have taken the
 * wireframe off the walls the user is looking at. The box is cheap and errs
 * towards drawing an edge, which is the safe way to be wrong.
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
 * Records in `cull.facing` which faces are turned towards the camera, or says
 * the cull does not hold from here (see `frontEdgePositions`).
 */
function faceCamera(cull: EdgeCull, eye: Vec3): boolean {
  const { normals, centres, facing, closed, bounds } = cull;
  if (!closed || withinBounds(bounds, eye)) return false;

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
 * way, so an open mesh, or a camera in among the geometry, keeps every edge.
 * A box cut in half shows the inside of its walls, and the faces you are
 * looking at there are turned away: culling them left the cut with no lines
 * on the side you can see into. Depth decides in those views, contour rounding
 * and all, which is what it did everywhere before this pass existed.
 *
 * `eye` is the camera in the mesh's own space, for the reason `cameraFacing`
 * gives. Skipped in x-ray and wireframe shading, where seeing through the model
 * is the point (see `ObjectView`).
 */
export function frontEdgePositions(cull: EdgeCull, eye: Vec3): Float32Array {
  const { ends, sides } = cull;

  if (!faceCamera(cull, eye)) return ends;

  const edges = sides.length / 2;

  // Counted before it is filled, so the buffer handed on is exactly the size it
  // needs and nothing has to be copied out of a larger one afterwards.
  let kept = 0;
  for (let edge = 0; edge < edges; edge++) if (onNearSide(cull, edge)) kept++;

  const positions = new Float32Array(kept * 6);
  let n = 0;
  for (let edge = 0; edge < edges; edge++) {
    if (!onNearSide(cull, edge)) continue;
    const from = edge * 6;
    positions[n] = ends[from];
    positions[n + 1] = ends[from + 1];
    positions[n + 2] = ends[from + 2];
    positions[n + 3] = ends[from + 3];
    positions[n + 4] = ends[from + 4];
    positions[n + 5] = ends[from + 5];
    n += 6;
  }

  return positions;
}

/**
 * The sharp edges worth drawing over an opaque surface, left out on the far
 * side the way `frontEdgePositions` leaves out the wireframe.
 *
 * They need it more than the wire does. A far-side edge comes through at a
 * contour as a stub a pixel or two long, which in the faint wire is easy to
 * miss and in cyan is not.
 */
export function frontSharpPositions(cull: EdgeCull, eye: Vec3): Float32Array {
  const { ends, sharp } = cull;
  if (sharp.length === 0) return new Float32Array(0);

  const culls = faceCamera(cull, eye);
  let kept = 0;
  for (const edge of sharp) if (!culls || onNearSide(cull, edge)) kept++;

  const positions = new Float32Array(kept * 6);
  let n = 0;
  for (const edge of sharp) {
    if (culls && !onNearSide(cull, edge)) continue;
    const from = edge * 6;
    positions[n] = ends[from];
    positions[n + 1] = ends[from + 1];
    positions[n + 2] = ends[from + 2];
    positions[n + 3] = ends[from + 3];
    positions[n + 4] = ends[from + 4];
    positions[n + 5] = ends[from + 5];
    n += 6;
  }

  return positions;
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
