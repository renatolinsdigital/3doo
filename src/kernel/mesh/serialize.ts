import { vec3 } from '../math';

import { BMesh } from './bmesh';
import type { Face, Vert } from './types';

/**
 * Flat, cycle-free mesh snapshot.
 *
 * This single format backs project save/load, undo snapshots and autosave.
 * Vertex positions are a flat XYZ array; faces index into it. Wire edges are
 * listed separately because they are not reachable from any face.
 */
export interface MeshData {
  version: 1;
  positions: number[];
  faces: number[][];
  materialIndices: number[];
  smooth: boolean[];
  uvs: number[][];
  wireEdges: [number, number][];
  sharpEdges: [number, number][];
  selection: {
    verts: number[];
    edges: [number, number][];
    faces: number[];
    /**
     * Click-selected vertices in selection order, so `merge at first/last`
     * still knows what the user picked first after an undo or a file reload.
     * Absent on projects written before this was recorded, and it lists only
     * the vertices that carry an order: a box or select-all leaves none.
     */
    vertOrder?: number[];
  };
}

export function serializeMesh(mesh: BMesh): MeshData {
  const vertIndex = new Map<number, number>();
  const positions: number[] = [];
  const selectedVerts: number[] = [];
  const ordered: { index: number; seq: number }[] = [];

  let index = 0;
  for (const vert of mesh.verts.values()) {
    vertIndex.set(vert.id, index);
    positions.push(vert.co.x, vert.co.y, vert.co.z);
    if (vert.selected) {
      selectedVerts.push(index);
      if (vert.selectSeq > 0) ordered.push({ index, seq: vert.selectSeq });
    }
    index++;
  }

  const vertOrder = ordered.sort((a, b) => a.seq - b.seq).map((entry) => entry.index);

  const faces: number[][] = [];
  const materialIndices: number[] = [];
  const smooth: boolean[] = [];
  const uvs: number[][] = [];
  const selectedFaces: number[] = [];

  let faceIndex = 0;
  for (const face of mesh.faces.values()) {
    const loops = mesh.faceLoops(face);
    faces.push(loops.map((loop) => vertIndex.get(loop.vert.id) ?? 0));
    materialIndices.push(face.materialIndex);
    smooth.push(face.smooth);
    uvs.push(loops.flatMap((loop) => [loop.uv.u, loop.uv.v]));
    if (face.selected) selectedFaces.push(faceIndex);
    faceIndex++;
  }

  const wireEdges: [number, number][] = [];
  const sharpEdges: [number, number][] = [];
  const selectedEdges: [number, number][] = [];

  for (const edge of mesh.edges.values()) {
    const a = vertIndex.get(edge.v0.id) ?? 0;
    const b = vertIndex.get(edge.v1.id) ?? 0;
    if (edge.loops.length === 0) wireEdges.push([a, b]);
    if (edge.sharp) sharpEdges.push([a, b]);
    if (edge.selected) selectedEdges.push([a, b]);
  }

  return {
    version: 1,
    positions,
    faces,
    materialIndices,
    smooth,
    uvs,
    wireEdges,
    sharpEdges,
    selection: {
      verts: selectedVerts,
      edges: selectedEdges,
      faces: selectedFaces,
      vertOrder,
    },
  };
}

export function deserializeMesh(data: MeshData): BMesh {
  const mesh = new BMesh();
  const verts: Vert[] = [];

  for (let i = 0; i < data.positions.length; i += 3) {
    verts.push(mesh.addVert(vec3(data.positions[i], data.positions[i + 1], data.positions[i + 2])));
  }

  const createdFaces: Face[] = [];
  for (let i = 0; i < data.faces.length; i++) {
    const ring = data.faces[i].map((vertexIndex) => verts[vertexIndex]).filter(Boolean);
    if (ring.length < 3) continue;
    const face = mesh.addFace(ring, {
      materialIndex: data.materialIndices[i] ?? 0,
      smooth: data.smooth[i] ?? false,
    });
    const uv = data.uvs[i];
    if (uv) {
      const loops = mesh.faceLoops(face);
      for (let l = 0; l < loops.length; l++) {
        loops[l].uv = { u: uv[l * 2] ?? 0, v: uv[l * 2 + 1] ?? 0 };
      }
    }
    createdFaces.push(face);
  }

  for (const [a, b] of data.wireEdges) {
    if (verts[a] && verts[b]) mesh.addEdge(verts[a], verts[b]);
  }

  for (const [a, b] of data.sharpEdges) {
    const edge = verts[a] && verts[b] ? mesh.findEdge(verts[a], verts[b]) : null;
    if (edge) edge.sharp = true;
  }

  for (const vertexIndex of data.selection.verts) {
    if (verts[vertexIndex]) verts[vertexIndex].selected = true;
  }
  // Replaying through `selectVert` re-stamps the click order; the values are
  // renumbered from 1, which is fine because only their order is ever read.
  for (const vertexIndex of data.selection.vertOrder ?? []) {
    const vert = verts[vertexIndex];
    if (vert?.selected) mesh.selectVert(vert);
  }
  for (const [a, b] of data.selection.edges) {
    const edge = verts[a] && verts[b] ? mesh.findEdge(verts[a], verts[b]) : null;
    if (edge) edge.selected = true;
  }
  for (const faceIndex of data.selection.faces) {
    if (createdFaces[faceIndex]) createdFaces[faceIndex].selected = true;
  }

  mesh.computeNormals();
  return mesh;
}

export function cloneMesh(mesh: BMesh): BMesh {
  return deserializeMesh(serializeMesh(mesh));
}

/**
 * Splits a mesh into one mesh per loose part.
 *
 * A loose part is a set of vertices reachable from one another through faces or
 * wire edges: the shells a mesh falls into when nothing joins them. Always
 * returns at least one mesh, so a caller reads "nothing to separate" as a
 * length of one.
 *
 * Going through `MeshData` rather than the half-edge graph is what carries UVs,
 * sharp edges, smoothing, material slots and the selection across for free:
 * every part is rebuilt the same way a saved file is.
 */
export function splitLooseParts(mesh: BMesh): BMesh[] {
  const data = serializeMesh(mesh);
  const vertexCount = data.positions.length / 3;

  // Union-find over vertex indices: it does not care whether two vertices are
  // joined through a face or a bare wire edge, and needs no adjacency map.
  const parent = Array.from({ length: vertexCount }, (_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    for (let walk = index; parent[walk] !== root;) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (const face of data.faces) {
    for (let i = 1; i < face.length; i++) union(face[0], face[i]);
  }
  for (const [a, b] of data.wireEdges) union(a, b);

  const groups = new Map<number, number[]>();
  for (let index = 0; index < vertexCount; index++) {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(index);
    else groups.set(root, [index]);
  }

  if (groups.size <= 1) return [deserializeMesh(data)];

  return [...groups.values()].map((vertices) => {
    const remap = new Map(vertices.map((index, position) => [index, position]));
    const inPart = (index: number): boolean => remap.has(index);
    const at = (index: number): number => remap.get(index) as number;
    const pairsInPart = (pairs: readonly [number, number][]): [number, number][] =>
      pairs.filter(([a]) => inPart(a)).map(([a, b]) => [at(a), at(b)]);

    const positions: number[] = [];
    for (const index of vertices) {
      positions.push(
        data.positions[index * 3],
        data.positions[index * 3 + 1],
        data.positions[index * 3 + 2],
      );
    }

    const faces: number[][] = [];
    const materialIndices: number[] = [];
    const smooth: boolean[] = [];
    const uvs: number[][] = [];
    const kept: number[] = [];

    data.faces.forEach((face, faceIndex) => {
      if (!inPart(face[0])) return;
      faces.push(face.map(at));
      materialIndices.push(data.materialIndices[faceIndex] ?? 0);
      smooth.push(data.smooth[faceIndex] ?? false);
      uvs.push(data.uvs[faceIndex] ?? []);
      kept.push(faceIndex);
    });

    const facePosition = new Map(kept.map((faceIndex, position) => [faceIndex, position]));

    return deserializeMesh({
      version: 1,
      positions,
      faces,
      materialIndices,
      smooth,
      uvs,
      wireEdges: pairsInPart(data.wireEdges),
      sharpEdges: pairsInPart(data.sharpEdges),
      selection: {
        verts: data.selection.verts.filter(inPart).map(at),
        edges: pairsInPart(data.selection.edges),
        faces: data.selection.faces
          .filter((faceIndex) => facePosition.has(faceIndex))
          .map((faceIndex) => facePosition.get(faceIndex) as number),
        vertOrder: data.selection.vertOrder?.filter(inPart).map(at),
      },
    });
  });
}
