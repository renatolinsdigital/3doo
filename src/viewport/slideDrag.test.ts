import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { slideFactor } from './Viewport';

/** A rail 100px to the right on screen, and 60px to the left the other way. */
const positive = new THREE.Vector2(100, 0);
const negative = new THREE.Vector2(-60, 0);

const travelled = (x: number, y = 0) => new THREE.Vector2(x, y);

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
