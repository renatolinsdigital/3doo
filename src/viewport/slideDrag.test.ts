import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { Vec3 } from '@kernel/index';

import { slideAim, slideFactor } from './Viewport';

/** A rail 100px to the right on screen, and 60px to the left the other way. */
const positive = new THREE.Vector2(100, 0);
const negative = new THREE.Vector2(-60, 0);

const travelled = (x: number, y = 0) => new THREE.Vector2(x, y);

/**
 * A camera looking down -Z from 10 metres back, drawn into 800x600 pixels.
 *
 * The same projection the viewport runs, built by hand because the viewport
 * itself needs a WebGL context and cannot be instantiated here.
 */
function projector(): (point: Vec3) => THREE.Vector2 {
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  return (point) => {
    const ndc = new THREE.Vector3(point.x, point.y, point.z).project(camera);
    return new THREE.Vector2(((ndc.x + 1) / 2) * 800, ((1 - ndc.y) / 2) * 600);
  };
}

const origin: Vec3 = { x: 0, y: 0, z: 0 };

describe('slide aim', () => {
  it('takes the edge that points at the cursor even where it runs into the screen', () => {
    // Both leave the origin to the right on screen. The first is nearly all
    // depth, so it is drawn as a stub; the second lies flat across the view but
    // climbs away from a cursor sitting out to the right.
    const intoScreen: Vec3 = { x: 0.1, y: 0, z: -0.99 };
    const acrossView: Vec3 = { x: 0.34, y: 0.94, z: 0 };

    const aim = slideAim(projector(), new THREE.Vector2(200, 0));

    expect(aim(origin, intoScreen)).toBeGreaterThan(aim(origin, acrossView));
  });

  it('scores an edge running back from the cursor lowest, which is the way back', () => {
    const aim = slideAim(projector(), new THREE.Vector2(200, 0));

    expect(aim(origin, { x: -1, y: 0, z: 0 })).toBeCloseTo(-1, 6);
    expect(aim(origin, { x: 1, y: 0, z: 0 })).toBeCloseTo(1, 6);
  });

  it('gives an edge seen exactly end on no say either way', () => {
    // Straight at the camera: it is a point where it is drawn, so it names no
    // direction, and zero leaves it behind both a way out and a way back.
    const aim = slideAim(projector(), new THREE.Vector2(200, 0));

    expect(aim(origin, { x: 0, y: 0, z: 1 })).toBe(0);
  });
});

describe('slide factor', () => {
  it('starts at nothing, so the selection cannot jump on the first move', () => {
    expect(slideFactor(travelled(0), positive, negative)).toBe(0);
  });

  it('reaches the far end exactly when the pointer has crossed the rail', () => {
    expect(slideFactor(travelled(100), positive, negative)).toBeCloseTo(1, 6);
    expect(slideFactor(travelled(-60), positive, negative)).toBeCloseTo(-1, 6);
  });

  it('reads each way against its own end, because a rail can bend at the vertex', () => {
    // Half of the shorter way back is still half, even though it is 30px
    // against 50px going forward.
    expect(slideFactor(travelled(-30), positive, negative)).toBeCloseTo(-0.5, 6);
    expect(slideFactor(travelled(50), positive, negative)).toBeCloseTo(0.5, 6);
  });

  it('never runs past either end, however far the pointer is dragged', () => {
    expect(slideFactor(travelled(4000), positive, negative)).toBe(1);
    expect(slideFactor(travelled(-4000), positive, negative)).toBe(-1);
  });

  it('ignores the part of the drag that runs across the rail', () => {
    // Only travel along the rail counts, so a drag that wanders off it slides
    // by what it covered in the useful direction and no more.
    expect(slideFactor(travelled(50, 400), positive, negative)).toBeCloseTo(0.5, 6);
  });

  it('stays put where a rail has no way to go', () => {
    const closed = new THREE.Vector2(0, 0);
    expect(slideFactor(travelled(-500), positive, closed)).toBe(-0);
    expect(slideFactor(travelled(500), closed, negative)).toBe(0);
  });
});
