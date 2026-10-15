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
    const inPart = new Set(vertices);
    const faces = data.faces.flatMap((face, faceIndex) => (inPart.has(face[0]) ? [faceIndex] : []));
    return meshPart(data, vertices, faces, true);
  });
}

/**
 * Splits the selected faces off a mesh: the first mesh holds the rest, the
 * second the selection. A vertex on the border between them goes into both, so
 * the two come apart there instead of sharing it.
 *
 * Wire edges and loose vertices stay with the rest, since no selected face
 * holds them. The rest comes back with nothing selected: the selection is what
 * left it.
 */
export function splitSelectedFaces(mesh: BMesh): [rest: BMesh, selected: BMesh] {
  const [rest, selected] = splitFaces(mesh, (face) => face.selected);
  rest.deselectAll();
  return [rest, selected];
}

/**
 * Splits the faces `pick` chooses off a mesh: the first mesh holds the rest,
 * the second the faces chosen. A vertex on the border between them goes into
 * both, so the two come apart there. Wire edges and loose vertices stay with
 * the rest, and each side keeps the selection it holds.
 */
export function splitFaces(
  mesh: BMesh,
  pick: (face: Face) => boolean,
): [rest: BMesh, chosen: BMesh] {
  const data = serializeMesh(mesh);
  // `serializeMesh` writes the faces in the order the mesh holds them.
  const picked = new Set<number>();
  [...mesh.faces.values()].forEach((face, faceIndex) => {
    if (pick(face)) picked.add(faceIndex);
  });
  const chosenFaces: number[] = [];
  const restFaces: number[] = [];
  data.faces.forEach((_, faceIndex) =>
    (picked.has(faceIndex) ? chosenFaces : restFaces).push(faceIndex),
  );

  const chosenVerts = new Set(chosenFaces.flatMap((faceIndex) => data.faces[faceIndex]));
  const restVerts = new Set(restFaces.flatMap((faceIndex) => data.faces[faceIndex]));
  for (const [a, b] of data.wireEdges) restVerts.add(a).add(b);

  const vertices = Array.from({ length: data.positions.length / 3 }, (_, index) => index);
  return [
    meshPart(
      data,
      vertices.filter((index) => restVerts.has(index) || !chosenVerts.has(index)),
      restFaces,
      true,
    ),
    meshPart(
      data,
      vertices.filter((index) => chosenVerts.has(index)),
      chosenFaces,
      false,
    ),
  ];
}

/**
 * The piece of `data` made of `vertices` and `faces`, renumbered to stand on
 * its own. Sharp and selected edges come along when both their ends are in the
 * piece, and so do wire edges when `wireEdges` is set.
 *
 * Going through `MeshData` rather than the half-edge graph is what carries UVs,
 * sharp edges, smoothing, material slots and the selection across for free:
 * every piece is rebuilt the same way a saved file is.
 */
function meshPart(
  data: MeshData,
  vertices: readonly number[],
  faces: readonly number[],
  wireEdges: boolean,
): BMesh {
  const remap = new Map(vertices.map((index, position) => [index, position]));
  const inPart = (index: number): boolean => remap.has(index);
  const at = (index: number): number => remap.get(index) as number;
  const pairsInPart = (pairs: readonly [number, number][]): [number, number][] =>
    pairs.filter(([a, b]) => inPart(a) && inPart(b)).map(([a, b]) => [at(a), at(b)]);
  const facePosition = new Map(faces.map((faceIndex, position) => [faceIndex, position]));

  return deserializeMesh({
    version: 1,
    positions: vertices.flatMap((index) => [
      data.positions[index * 3],
      data.positions[index * 3 + 1],
      data.positions[index * 3 + 2],
    ]),
    faces: faces.map((faceIndex) => data.faces[faceIndex].map(at)),
    materialIndices: faces.map((faceIndex) => data.materialIndices[faceIndex] ?? 0),
    smooth: faces.map((faceIndex) => data.smooth[faceIndex] ?? false),
    uvs: faces.map((faceIndex) => data.uvs[faceIndex] ?? []),
    wireEdges: wireEdges ? pairsInPart(data.wireEdges) : [],
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
}
