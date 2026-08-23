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
  };
}

export function serializeMesh(mesh: BMesh): MeshData {
  const vertIndex = new Map<number, number>();
  const positions: number[] = [];
  const selectedVerts: number[] = [];

  let index = 0;
  for (const vert of mesh.verts.values()) {
    vertIndex.set(vert.id, index);
    positions.push(vert.co.x, vert.co.y, vert.co.z);
    if (vert.selected) selectedVerts.push(index);
    index++;
  }

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
    selection: { verts: selectedVerts, edges: selectedEdges, faces: selectedFaces },
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
