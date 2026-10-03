import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { type BMesh, type Vert, createBox, createPlane, execOperator, vec3 } from '@kernel/index';

import { KNIFE_CURSOR } from './Viewport';
import {
  type KnifeAnchor,
  type KnifeMark,
  type KnifeStep,
  type KnifeView,
  knifeCutRuns,
  knifeMarks,
  knifeSections,
  knifeTarget,
  knifeViewOf,
} from './knife';

const SIZE = { width: 200, height: 200 };

/** Looking straight at the front of the scene: world (x, y) lands at pixel (100 + 40x, 100 - 40y). */
function front(): THREE.Camera {
  const camera = new THREE.OrthographicCamera(-2.5, 2.5, 2.5, -2.5, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function perspective(): THREE.Camera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function viewFrom(camera: THREE.Camera, occlude = true): KnifeView {
  return knifeViewOf(camera, new THREE.Matrix4(), SIZE, occlude);
}

function vertAt(mesh: BMesh, x: number, y: number, z: number): Vert {
  const found = [...mesh.verts.values()].find(
    (vert) => vert.co.x === x && vert.co.y === y && vert.co.z === z,
  );
  if (!found) throw new Error(`no vertex at ${x}, ${y}, ${z}`);
  return found;
}

/** A click out over empty space, `x` along the horizontal through the middle of the view. */
function offMesh(x: number): KnifeAnchor {
  return { at: vec3(x, 0, 0), mark: null };
}

/** A click that landed on the mesh, so its mark is there to be compared against. */
type Landed = KnifeAnchor & { mark: KnifeMark };

function onVert(vert: Vert): Landed {
  const mark: KnifeMark = { point: { kind: 'vert', vert: vert.id }, co: vert.co };
  return { at: vert.co, mark };
}

function inFront(mesh: BMesh, x: number, y: number): Landed {
  const face = [...mesh.faces.values()].find((candidate) => candidate.normal.z > 0.99);
  if (!face) throw new Error('no front face');
  const co = vec3(x, y, 1);
  return { at: co, mark: { point: { kind: 'face', face: face.id, co }, co } };
}

/** Which way the faces cut point, so a test can say which side of the box was cut. */
function cutFaces(mesh: BMesh, sections: { face: number }[]): string[] {
  return sections
    .map(({ face }) => {
      const normal = mesh.faces.get(face)?.normal;
      if (!normal) return '?';
      if (normal.z > 0.99) return 'front';
      if (normal.z < -0.99) return 'back';
      if (normal.x > 0.99) return 'right';
      if (normal.x < -0.99) return 'left';
      return normal.y > 0 ? 'top' : 'bottom';
    })
    .sort();
}

function step(anchor: KnifeAnchor, sections: KnifeStep['sections'], starts = false): KnifeStep {
  return { ...anchor, starts, sections };
}

describe('what a line of the knife cuts', () => {
  it('cuts only the face the camera sees, square on', () => {
    const box = createBox(2);

    const sections = knifeSections(box, offMesh(-3), offMesh(3), viewFrom(front()));

    expect(cutFaces(box, sections)).toEqual(['front']);
    for (const end of [sections[0].from, sections[0].to]) {
      expect(end.point.kind).toBe('edge');
      expect(end.co.y).toBeCloseTo(0);
      expect(end.co.z).toBeCloseTo(1);
    }
  });

  it('cuts only the near face in perspective too', () => {
    const box = createBox(2);

    const sections = knifeSections(box, offMesh(-3), offMesh(3), viewFrom(perspective()));

    expect(cutFaces(box, sections)).toEqual(['front']);
  });

  it('goes all the way round in a see-through view', () => {
    const box = createBox(2);

    const sections = knifeSections(box, offMesh(-3), offMesh(3), viewFrom(front(), false));

    expect(cutFaces(box, sections)).toEqual(['back', 'front', 'left', 'right']);
  });

  it('ends at a click inside a face', () => {
    const box = createBox(2);
    const from = inFront(box, -0.5, 0);
    const to = inFront(box, 0.5, 0.2);

    const sections = knifeSections(box, from, to, viewFrom(front()));

    expect(sections).toHaveLength(1);
    expect(sections[0].from).toBe(from.mark);
    expect(sections[0].to).toBe(to.mark);
  });

  it('runs out of a face from a click inside it', () => {
    const box = createBox(2);
    const from = inFront(box, 0, 0);

    const sections = knifeSections(box, from, offMesh(3), viewFrom(front()));

    expect(sections).toHaveLength(1);
    expect(sections[0].from).toBe(from.mark);
    expect(sections[0].to.point.kind).toBe('edge');
    expect(sections[0].to.co.x).toBeCloseTo(1);
  });

  it('runs corner to corner through the corners themselves', () => {
    const box = createBox(2);
    const from = onVert(vertAt(box, -1, -1, 1));
    const to = onVert(vertAt(box, 1, 1, 1));

    const sections = knifeSections(box, from, to, viewFrom(front()), [from.mark, to.mark]);

    expect(cutFaces(box, sections)).toEqual(['front']);
    expect(sections[0].from).toBe(from.mark);
    expect(sections[0].to).toBe(to.mark);
  });

  it('takes a line drawn a hair past a corner through it', () => {
    const box = createBox(2);
    // Half a pixel off the far corner of the front face, from the near one.
    const sections = knifeSections(
      box,
      onVert(vertAt(box, -1, -1, 1)),
      { at: vec3(1, 1.01, 1), mark: null },
      viewFrom(front()),
    );

    const ends = sections.flatMap((section) => [section.from.point, section.to.point]);
    expect(ends).toContainEqual({ kind: 'vert', vert: vertAt(box, 1, 1, 1).id });
    expect(ends.every((point) => point.kind === 'vert')).toBe(true);
  });

  it('goes through a point of the cut it passes within a pixel of', () => {
    const box = createBox(2);
    const first = knifeSections(box, offMesh(-3), offMesh(3), viewFrom(front()));
    const marks = [first[0].from, first[0].to];

    // A second line along nearly the same course, as a cut closing on itself does.
    const second = knifeSections(
      box,
      { at: vec3(-3, 0.02, 0), mark: null },
      { at: vec3(3, 0.02, 0), mark: null },
      viewFrom(front()),
      marks,
    );

    expect(second).toHaveLength(1);
    expect(marks).toContain(second[0].from);
    expect(marks).toContain(second[0].to);
  });
});

describe('where a knife click lands', () => {
  const nowhere = { surface: null, marks: [], sections: [], snap: true, midpoint: false };

  it('takes the near corner, not the one hidden straight behind it', () => {
    const box = createBox(2);

    const mark = knifeTarget(box, new THREE.Vector2(63, 63), viewFrom(front()), nowhere);

    expect(mark?.point).toEqual({ kind: 'vert', vert: vertAt(box, -1, 1, 1).id });
  });

  it('reaches the hidden corner in a see-through view', () => {
    const box = createBox(2);
    const behind = vertAt(box, -1, 1, -1);
    const ahead = vertAt(box, -1, 1, 1);

    const mark = knifeTarget(box, new THREE.Vector2(60, 60), viewFrom(front(), false), nowhere);

    expect([behind.id, ahead.id]).toContain((mark?.point as { vert: number }).vert);
  });

  it('lands on an edge where the pointer is, or on its middle with Ctrl', () => {
    const box = createBox(2);
    const pointer = new THREE.Vector2(116, 62);

    const free = knifeTarget(box, pointer, viewFrom(front()), nowhere);
    const middle = knifeTarget(box, pointer, viewFrom(front()), { ...nowhere, midpoint: true });

    expect(free?.point.kind).toBe('edge');
    expect(free?.co.x).toBeCloseTo(0.4);
    expect(free?.co.z).toBeCloseTo(1);
    expect(middle?.co.x).toBeCloseTo(0);
  });

  it('finds the spot under the pointer on an edge running away in perspective', () => {
    const box = createBox(2);
    // Up and to the right, so the edge between the top and the right face runs
    // away from the camera with both of its faces in view.
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(2, 2, 4);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const view = viewFrom(camera);
    const near = view.project(vec3(1, 1, 1));
    const far = view.project(vec3(1, 1, -1));
    if (!near || !far) throw new Error('corners off screen');
    expect(near.distanceTo(far)).toBeGreaterThan(30);
    const middle = near.clone().lerp(far, 0.5);

    const mark = knifeTarget(box, middle, view, nowhere);
    if (!mark) throw new Error('nothing under the pointer');

    expect(mark.point.kind).toBe('edge');
    expect(view.project(mark.co)?.distanceTo(middle)).toBeLessThan(0.01);
    // Halfway across the screen is short of halfway along the edge: the far
    // half of it is drawn smaller, so the spot lies nearer the camera.
    expect(mark.co.z).toBeGreaterThan(0.05);
  });

  it('lands inside the face once nothing is near enough to pull it', () => {
    const box = createBox(2);
    const surface = inFront(box, 0.1, 0.2).mark;

    expect(
      knifeTarget(box, new THREE.Vector2(104, 92), viewFrom(front()), { ...nowhere, surface }),
    ).toBe(surface);
  });

  it('ignores vertices and edges while Shift is held', () => {
    const box = createBox(2);
    const surface = inFront(box, -0.95, 0.95).mark;

    const mark = knifeTarget(box, new THREE.Vector2(62, 62), viewFrom(front()), {
      ...nowhere,
      surface,
      snap: false,
    });

    expect(mark).toBe(surface);
  });

  it('closes on a point of the cut already there', () => {
    const box = createBox(2);
    const earlier = inFront(box, 0.3, -0.3).mark;

    const mark = knifeTarget(box, new THREE.Vector2(116, 116), viewFrom(front()), {
      ...nowhere,
      marks: [earlier],
    });

    expect(mark).toBe(earlier);
  });

  it('lands on a piece of the cut already there', () => {
    const box = createBox(2);
    const [section] = knifeSections(box, offMesh(-3), offMesh(3), viewFrom(front()));

    const mark = knifeTarget(box, new THREE.Vector2(108, 104), viewFrom(front()), {
      ...nowhere,
      sections: [section],
    });

    expect(mark?.point).toMatchObject({ kind: 'face', face: section.face });
    expect(mark?.co.y).toBeCloseTo(0);
    expect(mark?.co.x).toBeCloseTo(0.2);
  });
});

describe('a knife cut, click to mesh', () => {
  /** Draws a cut through clicks, in one view, the way the viewport builds it. */
  function draw(mesh: BMesh, view: KnifeView, anchors: KnifeAnchor[]): KnifeStep[] {
    const steps: KnifeStep[] = [];
    for (const anchor of anchors) {
      const last = steps[steps.length - 1];
      const sections = last ? knifeSections(mesh, last, anchor, view, knifeMarks(steps)) : [];
      steps.push(step(anchor, sections, !last));
    }
    return steps;
  }

  const cut = (mesh: BMesh, steps: KnifeStep[]) =>
    execOperator({ mesh, selectMode: 'edge', cursor: vec3() }, 'knife', {
      cuts: knifeCutRuns(steps),
    });

  it('divides the face the line crosses and leaves the box closed', () => {
    const box = createBox(2);

    const result = cut(box, draw(box, viewFrom(front()), [offMesh(-3), offMesh(3)]));

    expect(result.refused).toBeUndefined();
    expect(box.faces.size).toBe(7);
    expect(box.verts.size - box.edges.size + box.faces.size).toBe(2);
    expect(box.validate()).toEqual([]);
  });

  it('slices all the way round in a see-through view', () => {
    const box = createBox(2);

    cut(box, draw(box, viewFrom(front(), false), [offMesh(-3), offMesh(3)]));

    expect(box.faces.size).toBe(10);
    expect(box.verts.size - box.edges.size + box.faces.size).toBe(2);
    for (const edge of box.edges.values()) expect(edge.loops).toHaveLength(2);
  });

  it('bends at a click inside a face', () => {
    const plane = createPlane(2);
    // The plane lies flat, so it is looked down on rather than at.
    const above = new THREE.OrthographicCamera(-2.5, 2.5, 2.5, -2.5, 0.1, 100);
    above.position.set(0, 10, 0);
    above.up.set(0, 0, -1);
    above.lookAt(0, 0, 0);
    above.updateMatrixWorld(true);
    above.updateProjectionMatrix();
    const face = [...plane.faces.values()][0];
    const co = vec3(0, 0, 0.4);

    const steps = draw(plane, viewFrom(above), [
      { at: vec3(-3, 0, 0), mark: null },
      { at: co, mark: { point: { kind: 'face', face: face.id, co }, co } },
      { at: vec3(3, 0, 0), mark: null },
    ]);
    cut(plane, steps);

    expect(plane.faces.size).toBe(2);
    expect(plane.validate()).toEqual([]);
  });

  it('crosses an earlier line of the same cut and divides the face four ways', () => {
    const box = createBox(2);
    const view = viewFrom(front());
    const across = draw(box, view, [offMesh(-3), offMesh(3)]);
    const down = draw(box, view, [
      { at: vec3(0, 3, 0), mark: null },
      { at: vec3(0, -3, 0), mark: null },
    ]);

    cut(box, [...across, ...down.map((each, i) => ({ ...each, starts: i === 0 }))]);

    expect(box.faces.size).toBe(9);
    expect(box.validate()).toEqual([]);
  });
});

describe('the knife cursor', () => {
  it('points with the tip of the blade, and falls back to a crosshair', () => {
    // The hotspot is where the point goes down, so it sits on the tip. The
    // crosshair is for a browser that will not take an SVG cursor.
    expect(KNIFE_CURSOR.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(KNIFE_CURSOR.endsWith('") 3 29, crosshair')).toBe(true);
  });

  it('escapes its SVG rather than trusting it raw in a URL', () => {
    const encoded = KNIFE_CURSOR.slice(KNIFE_CURSOR.indexOf(',') + 1).split('")')[0];

    expect(encoded).not.toMatch(/[<>#"]/);
    expect(decodeURIComponent(encoded)).toContain('<svg');
    expect(decodeURIComponent(encoded)).toContain('#e5342a');
  });
});
