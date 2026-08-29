import { type BMesh, type Face, type Vec3, triangulatePolygon } from '@kernel/index';

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

function buildSolid(mesh: BMesh): SolidBuffers {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const triangleFaceIds: number[] = [];
  const selectedTriangles: number[] = [];

  // Faces are visited in material order so each material becomes one draw call.
  const byMaterial = new Map<number, ReturnType<BMesh['selectedFaces']>>();
  for (const face of mesh.faces.values()) {
    const bucket = byMaterial.get(face.materialIndex);
    if (bucket) bucket.push(face);
    else byMaterial.set(face.materialIndex, [face]);
  }

  const groups: SolidBuffers['groups'] = [];
  for (const [materialIndex, faces] of [...byMaterial.entries()].sort((a, b) => a[0] - b[0])) {
    const start = positions.length / 3;

    for (const face of faces) {
      const loops = mesh.faceLoops(face);
      const points = loops.map((loop) => loop.vert.co);
      const indices = triangulatePolygon(points, face.normal);

      for (let i = 0; i < indices.length; i += 3) {
        triangleFaceIds.push(face.id);

        for (let corner = 0; corner < 3; corner++) {
          const loop = loops[indices[i + corner]];
          const normal = face.smooth ? loop.vert.normal : face.normal;
          positions.push(loop.vert.co.x, loop.vert.co.y, loop.vert.co.z);
          normals.push(normal.x, normal.y, normal.z);
          uvs.push(loop.uv.u, loop.uv.v);

          if (face.selected) {
            selectedTriangles.push(loop.vert.co.x, loop.vert.co.y, loop.vert.co.z);
          }
        }
      }
    }

    const count = positions.length / 3 - start;
    if (count > 0) groups.push({ start, count, materialIndex });
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    triangleFaceIds: new Int32Array(triangleFaceIds),
    groups,
    selectedTriangles: new Float32Array(selectedTriangles),
  };
}

function buildEdges(mesh: BMesh): EdgeBuffers {
  const positions: number[] = [];
  const edgeIds: number[] = [];
  const selectedPositions: number[] = [];

  for (const edge of mesh.edges.values()) {
    positions.push(edge.v0.co.x, edge.v0.co.y, edge.v0.co.z);
    positions.push(edge.v1.co.x, edge.v1.co.y, edge.v1.co.z);
    edgeIds.push(edge.id);

    if (edge.selected) {
      selectedPositions.push(edge.v0.co.x, edge.v0.co.y, edge.v0.co.z);
      selectedPositions.push(edge.v1.co.x, edge.v1.co.y, edge.v1.co.z);
    }
  }

  return {
    positions: new Float32Array(positions),
    edgeIds: new Int32Array(edgeIds),
    selectedPositions: new Float32Array(selectedPositions),
  };
}

/**
 * The edges that trace a mesh's outline from where the camera stands.
 *
 * An edge is on the silhouette when the two faces sharing it disagree about
 * facing the camera; an edge with anything other than two faces (a boundary,
 * a bare wire) always is, which is what gives flat and open shapes an outline
 * as well as closed ones.
 *
 * `eye` is the camera in the mesh's own space. Testing there rather than in
 * world space is not an approximation: for any invertible transform the sign of
 * `normal · (eye - centre)` is the same on both sides of it, so the answer is
 * exact and no face has to be transformed to get it.
 */
export function buildSilhouetteEdges(mesh: BMesh, eye: Vec3): Float32Array {
  const positions: number[] = [];
  // One test per face rather than one per edge-side: every face is shared.
  const facing = new Map<number, boolean>();

  const facesCamera = (face: Face): boolean => {
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
