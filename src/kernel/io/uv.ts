import type { BMesh } from '../mesh';

/**
 * Box-projected UVs.
 *
 * There is no texture pipeline, but exports still need a UV layer: importers in
 * Unity and Unreal warn or fail on meshes without one, so every face gets a
 * planar projection from its dominant axis.
 */
export function boxProjectUVs(mesh: BMesh, scale = 1): void {
  for (const face of mesh.faces.values()) {
    const { x, y, z } = face.normal;
    const absX = Math.abs(x);
    const absY = Math.abs(y);
    const absZ = Math.abs(z);

    for (const loop of mesh.faceLoops(face)) {
      const co = loop.vert.co;
      if (absY >= absX && absY >= absZ) {
        loop.uv = { u: co.x * scale, v: (y >= 0 ? co.z : -co.z) * scale };
      } else if (absX >= absZ) {
        loop.uv = { u: (x >= 0 ? -co.z : co.z) * scale, v: co.y * scale };
      } else {
        loop.uv = { u: (z >= 0 ? co.x : -co.x) * scale, v: co.y * scale };
      }
    }
  }
}
