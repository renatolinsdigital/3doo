import { describe, expect, it } from 'vitest';

import {
  type BMesh,
  type ProportionalOptions,
  createGrid,
  execOperator,
  medianPoint,
  vec3,
} from '@kernel/index';

import { type EditMove, EditMoveDrag } from './editMove';

/** A flat grid with the nine vertices round its middle selected. */
function grid(): BMesh {
  const mesh = createGrid(2, 8);
  for (const vert of mesh.verts.values()) {
    if (Math.abs(vert.co.x) < 0.3 && Math.abs(vert.co.z) < 0.3) mesh.selectVert(vert);
  }
  mesh.flushSelection('vertex');
  return mesh;
}

const falloff = (radius: number): ProportionalOptions => ({
  enabled: true,
  radius,
  falloff: 'smooth',
});
const off: ProportionalOptions = { enabled: false, radius: 1, falloff: 'smooth' };

/** Runs the drag's moves in order, as pointer moves would, on a fresh grid. */
function drag(steps: [EditMove, ProportionalOptions][]) {
  const mesh = grid();
  const transform = new EditMoveDrag(mesh, medianPoint(mesh.selectedVerts()));
  for (const [move, proportional] of steps) {
    transform.apply(move, mesh.selectedVerts(), proportional);
  }
  return { mesh, transform };
}

/** Every vertex of `actual` where the same vertex of `expected` stands. */
function expectSameShape(actual: BMesh, expected: BMesh) {
  const points = (mesh: BMesh) => [...mesh.verts.values()].map((vert) => vert.co);
  const want = points(expected);
  points(actual).forEach((point, index) => {
    expect(point.x).toBeCloseTo(want[index].x, 9);
    expect(point.y).toBeCloseTo(want[index].y, 9);
    expect(point.z).toBeCloseTo(want[index].z, 9);
  });
}

/** The call the drag reports, run once on a grid the drag never touched. */
function replay(transform: EditMoveDrag, median = true): BMesh {
  const call = transform.call(median);
  if (!call) throw new Error('The drag reported no call');
  const mesh = grid();
  execOperator({ mesh, selectMode: 'vertex', cursor: vec3() }, call.name, call.params);
  return mesh;
}

const pivot = vec3();
const lift = (y: number): EditMove => ({ kind: 'translate', offset: vec3(0, y, 0) });
const grow = (factor: number): EditMove => ({
  kind: 'scale',
  factor: vec3(factor, factor, factor),
  pivot,
});

describe('EditMoveDrag', () => {
  it('ends a proportional scale where one scale call with the same settings would', () => {
    // Stacked step on step, the falloff was multiplied into every one of them
    // and no single call could say what the drag had done.
    const { mesh, transform } = drag([
      [grow(1.2), falloff(0.6)],
      [grow(1.5), falloff(0.6)],
      [grow(1.8), falloff(0.6)],
    ]);

    expect(transform.call(true)).toEqual({
      name: 'scale',
      params: { scale: vec3(1.8, 1.8, 1.8), proportional: 0.6 },
    });
    expectSameShape(mesh, replay(transform));
  });

  it('spreads the whole move at the radius the wheel left, not only what came after it', () => {
    const { mesh, transform } = drag([
      [lift(0.4), falloff(0.5)],
      [lift(0.6), falloff(0.5)],
      [lift(0.6), falloff(1.2)],
      [lift(0.7), falloff(0.8)],
    ]);

    expect(transform.call(true)?.params).toEqual({ offset: vec3(0, 0.7, 0), proportional: 0.8 });
    expectSameShape(mesh, replay(transform));
  });

  it('turns about the axis pinned last, from where the turn began', () => {
    const { mesh, transform } = drag([
      [{ kind: 'rotate', axis: vec3(1, 0, 0), angle: 0.3, pivot }, falloff(0.7)],
      [{ kind: 'rotate', axis: vec3(1, 0, 0), angle: 0.5, pivot }, falloff(0.7)],
      [{ kind: 'rotate', axis: vec3(0, 0, -1), angle: 0.2, pivot }, falloff(0.7)],
    ]);

    const call = transform.call(true);
    // About -Z is about "z" the other way, which is how a person writes it.
    expect(call?.params.axis).toBe('z');
    expect(call?.params.angle).toBeCloseTo(-11.459156, 5);
    expectSameShape(mesh, replay(transform));
  });

  it('names the pivot only when it is not the middle of the selection', () => {
    const away = vec3(1, 0, 1);
    const { mesh, transform } = drag([
      [{ kind: 'rotate', axis: vec3(0, 0.6, 0.8), angle: 0.9, pivot: away }, off],
    ]);

    expect(transform.call(false)?.params).toEqual({
      axis: vec3(0, 0.6, 0.8),
      angle: (0.9 * 180) / Math.PI,
      pivot: away,
    });
    expectSameShape(mesh, replay(transform, false));
    expect(transform.call(true)?.params.pivot).toBeUndefined();
  });

  it('puts back what a narrower falloff no longer reaches', () => {
    const { mesh } = drag([
      [lift(0.5), falloff(1.5)],
      [lift(0.5), off],
    ]);
    const plain = drag([[lift(0.5), off]]).mesh;

    expectSameShape(mesh, plain);
  });

  it('reports nothing for a drag that ends where it began', () => {
    const { mesh, transform } = drag([
      [lift(0.5), falloff(0.6)],
      [lift(0), falloff(0.6)],
    ]);

    expect(transform.call(true)).toBeNull();
    expectSameShape(mesh, grid());
  });

  it('does nothing for a step that asks for the move already made', () => {
    const mesh = grid();
    const transform = new EditMoveDrag(mesh, pivot);

    expect(transform.apply(lift(0.25), mesh.selectedVerts(), off)).toBe(true);
    expect(transform.apply(lift(0.25), mesh.selectedVerts(), off)).toBe(false);
    expect(transform.apply(lift(0.25), mesh.selectedVerts(), falloff(0.5))).toBe(true);
  });
});
