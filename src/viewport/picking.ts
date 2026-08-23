import * as THREE from 'three';

import type { BMesh, SelectMode } from '@kernel/index';
import type { ObjectView } from '@bridge/index';

export interface PickResult {
  kind: SelectMode;
  elementId: number;
}

const PICK_RADIUS_PIXELS = 12;

function project(
  point: THREE.Vector3,
  matrix: THREE.Matrix4,
  camera: THREE.Camera,
  width: number,
  height: number,
): THREE.Vector2 | null {
  const world = point.clone().applyMatrix4(matrix);
  const ndc = world.project(camera);
  // Behind the camera, or outside the depth range: not pickable.
  if (ndc.z < -1 || ndc.z > 1) return null;
  return new THREE.Vector2(((ndc.x + 1) / 2) * width, ((1 - ndc.y) / 2) * height);
}

/**
 * Picks a vertex or edge in screen space rather than by raycast.
 *
 * Vertices and edges have no area to hit, so distance-in-pixels is both more
 * forgiving and closer to what the user sees than a 3D intersection test.
 */
export function pickElement(
  view: ObjectView,
  mesh: BMesh,
  mode: SelectMode,
  pointer: THREE.Vector2,
  camera: THREE.Camera,
  size: { width: number; height: number },
  raycaster: THREE.Raycaster,
): PickResult | null {
  const matrix = view.group.matrix;

  if (mode === 'vertex') {
    let best: PickResult | null = null;
    let bestDistance = PICK_RADIUS_PIXELS;

    for (let i = 0; i < view.vertIds.length; i++) {
      const position = new THREE.Vector3(
        view.vertPositions[i * 3],
        view.vertPositions[i * 3 + 1],
        view.vertPositions[i * 3 + 2],
      );
      const screen = project(position, matrix, camera, size.width, size.height);
      if (!screen) continue;

      const distance = screen.distanceTo(pointer);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { kind: 'vertex', elementId: view.vertIds[i] };
      }
    }
    return best;
  }

  if (mode === 'edge') {
    let best: PickResult | null = null;
    let bestDistance = PICK_RADIUS_PIXELS;

    for (let i = 0; i < view.edgeIds.length; i++) {
      const a = project(
        new THREE.Vector3(
          view.edgePositions[i * 6],
          view.edgePositions[i * 6 + 1],
          view.edgePositions[i * 6 + 2],
        ),
        matrix,
        camera,
        size.width,
        size.height,
      );
      const b = project(
        new THREE.Vector3(
          view.edgePositions[i * 6 + 3],
          view.edgePositions[i * 6 + 4],
          view.edgePositions[i * 6 + 5],
        ),
        matrix,
        camera,
        size.width,
        size.height,
      );
      if (!a || !b) continue;

      const distance = distanceToSegment(pointer, a, b);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { kind: 'edge', elementId: view.edgeIds[i] };
      }
    }
    return best;
  }

  const hits = raycaster.intersectObject(view.pickTarget, false);
  const hit = hits[0];
  if (!hit || hit.faceIndex == null) return null;

  const faceId = view.triangleFaceIds[hit.faceIndex];
  if (faceId === undefined || !mesh.faces.has(faceId)) return null;
  return { kind: 'face', elementId: faceId };
}

function distanceToSegment(point: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const segment = b.clone().sub(a);
  const lengthSq = segment.lengthSq();
  if (lengthSq < 1e-6) return point.distanceTo(a);

  const t = THREE.MathUtils.clamp(point.clone().sub(a).dot(segment) / lengthSq, 0, 1);
  return point.distanceTo(a.clone().addScaledVector(segment, t));
}

export interface BoxSelectRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Collects every element whose screen position falls inside the drag rectangle. */
export function pickInRectangle(
  view: ObjectView,
  mode: SelectMode,
  rect: BoxSelectRect,
  camera: THREE.Camera,
  size: { width: number; height: number },
  mesh: BMesh,
): number[] {
  const matrix = view.group.matrix;
  const inside = (screen: THREE.Vector2 | null) =>
    screen !== null &&
    screen.x >= rect.minX &&
    screen.x <= rect.maxX &&
    screen.y >= rect.minY &&
    screen.y <= rect.maxY;

  if (mode === 'vertex') {
    const hits: number[] = [];
    for (let i = 0; i < view.vertIds.length; i++) {
      const screen = project(
        new THREE.Vector3(
          view.vertPositions[i * 3],
          view.vertPositions[i * 3 + 1],
          view.vertPositions[i * 3 + 2],
        ),
        matrix,
        camera,
        size.width,
        size.height,
      );
      if (inside(screen)) hits.push(view.vertIds[i]);
    }
    return hits;
  }

  if (mode === 'edge') {
    const hits: number[] = [];
    for (const edge of mesh.edges.values()) {
      const center = mesh.edgeCenter(edge);
      const screen = project(
        new THREE.Vector3(center.x, center.y, center.z),
        matrix,
        camera,
        size.width,
        size.height,
      );
      if (inside(screen)) hits.push(edge.id);
    }
    return hits;
  }

  const hits: number[] = [];
  for (const face of mesh.faces.values()) {
    const center = mesh.faceCenter(face);
    const screen = project(
      new THREE.Vector3(center.x, center.y, center.z),
      matrix,
      camera,
      size.width,
      size.height,
    );
    if (inside(screen)) hits.push(face.id);
  }
  return hits;
}
