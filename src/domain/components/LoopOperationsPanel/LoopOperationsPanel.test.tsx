import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subdivideFaces } from '@kernel/index';
import { useEditorStore } from '@store/index';

import { LoopOperationsPanel } from './LoopOperationsPanel';

function activeMesh() {
  const state = useEditorStore.getState();
  const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
  if (!object) throw new Error('no active object');
  return object.mesh;
}

function editBox() {
  const store = useEditorStore.getState();
  store.resetScene();
  store.addPrimitive('cube');
  store.setMode('edit');
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

const OPERATIONS = ['LOOP CUT', 'SUBDIVIDE', 'RELAX', 'CIRCLE', 'SPACE'];

/** A cylinder in edit mode with its top ring selected, as a loop operator wants. */
function editTopRing() {
  const store = useEditorStore.getState();
  store.resetScene();
  store.addPrimitive('cylinder');
  store.setMode('edit');

  const mesh = activeMesh();
  const ring = [...mesh.verts.values()].filter((vert) => vert.co.y > 0);
  act(() => {
    for (const vert of ring) vert.selected = true;
    mesh.flushSelection('vertex');
    useEditorStore.getState().touchMesh();
  });
  return ring;
}

type RingVert = { co: { x: number; y: number; z: number } };

/** How far each of `ring` sits from the axis the cylinder was built on. */
function radii(ring: readonly RingVert[]): number[] {
  return ring.map((vert) => Math.hypot(vert.co.x, vert.co.z));
}

const angleOf = (vert: RingVert) => Math.atan2(vert.co.z, vert.co.x);

/** The ring in the order it runs round the axis, whatever the mesh order is. */
function byAngle(ring: readonly RingVert[]): RingVert[] {
  return ring.slice().sort((a, b) => angleOf(a) - angleOf(b));
}

/** The widest gap round the ring over the narrowest: 1 when the spacing is even. */
function evenness(ring: readonly RingVert[]): number {
  const sorted = byAngle(ring);
  const gaps = sorted.map((vert, i) => {
    const next = sorted[(i + 1) % sorted.length];
    return Math.hypot(vert.co.x - next.co.x, vert.co.z - next.co.z);
  });
  return Math.max(...gaps) / Math.min(...gaps);
}

/** A box grown to a few thousand faces, the way a session of subdividing does. */
function denseBox() {
  const mesh = activeMesh();
  subdivideFaces(mesh, [...mesh.faces.values()], { cuts: 4 });
  subdivideFaces(mesh, [...mesh.faces.values()], { cuts: 4 });
  act(() => {
    mesh.selectAll();
    useEditorStore.getState().touchMesh();
  });
}

/** The SUBDIVIDE section's own cuts field; LOOP CUT has one by the same name. */
async function setSubdivideCuts(value: string) {
  const field = screen.getAllByLabelText('CUTS')[1];
  await userEvent.clear(field);
  await userEvent.type(field, `${value}{Enter}`);
}

describe('LoopOperationsPanel', () => {
  beforeEach(() => {
    editBox();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disables every operation the current selection cannot feed', () => {
    render(<LoopOperationsPanel />);

    for (const name of OPERATIONS) {
      expect(button(name)).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('enables them again once there is something to act on', () => {
    render(<LoopOperationsPanel />);

    act(() => {
      activeMesh().selectAll();
      useEditorStore.getState().touchMesh();
    });

    for (const name of OPERATIONS) {
      expect(button(name)).not.toHaveAttribute('aria-disabled');
    }
  });

  it('will not start a subdivision too big for a browser tab to hold', async () => {
    denseBox();
    render(<LoopOperationsPanel />);
    await setSubdivideCuts('16');

    // 3,750 faces at sixteen cuts is over a million: refused outright, and the
    // button says why rather than leaving the user to find out.
    expect(button('SUBDIVIDE')).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button('SUBDIVIDE'));
    expect(activeMesh().faces.size).toBe(3750);
  });

  it('says how big a heavy subdivision is before running it', async () => {
    denseBox();
    render(<LoopOperationsPanel />);
    await setSubdivideCuts('4');

    await userEvent.click(button('SUBDIVIDE'));

    // Nothing has run yet: the warning stands between the click and the work.
    expect(activeMesh().faces.size).toBe(3750);
    const warning = screen.getByRole('dialog');
    expect(warning).toHaveTextContent('93,750');

    await userEvent.click(within(warning).getByRole('button', { name: 'SUBDIVIDE ANYWAY' }));
    expect(activeMesh().faces.size).toBe(93750);
  });

  it('rounds a squashed ring back out onto a circle', async () => {
    const ring = editTopRing();
    act(() => {
      for (const vert of ring) vert.co = { ...vert.co, x: vert.co.x * 0.5 };
      useEditorStore.getState().touchMesh();
    });
    render(<LoopOperationsPanel />);

    await userEvent.click(button('CIRCLE'));

    const after = radii(ring);
    expect(Math.max(...after) / Math.min(...after)).toBeCloseTo(1, 9);
  });

  it('evens out the gaps of a bunched ring without adding geometry', async () => {
    const ring = editTopRing();
    const mesh = activeMesh();
    const before = { verts: mesh.verts.size, faces: mesh.faces.size };
    // One vertex of the ring slid round to within a degree of its neighbour,
    // where the rest of a 24 segment ring sits fifteen degrees apart.
    act(() => {
      const sorted = byAngle(ring);
      const crowded = angleOf(sorted[4]) + Math.PI / 180;
      sorted[5].co = {
        x: Math.cos(crowded) * 0.5,
        y: sorted[5].co.y,
        z: Math.sin(crowded) * 0.5,
      };
      useEditorStore.getState().touchMesh();
    });
    expect(evenness(ring)).toBeGreaterThan(10);
    render(<LoopOperationsPanel />);

    await userEvent.click(button('SPACE'));

    expect(evenness(ring)).toBeLessThan(1.2);
    expect(mesh.verts.size).toBe(before.verts);
    expect(mesh.faces.size).toBe(before.faces);
  });

  it('relaxes the selection without adding or removing geometry', async () => {
    render(<LoopOperationsPanel />);

    const mesh = activeMesh();
    // One corner dragged off the cube into a spike. Keeping the shape would
    // leave it where it is, since a spike is part of the surface, and relax slides
    // along the surface, so the test turns that off and watches it come back.
    const [corner] = [...mesh.verts.values()];
    corner.co = { x: 6, y: 6, z: 6 };
    act(() => {
      mesh.selectAll();
      useEditorStore.getState().touchMesh();
    });

    const before = { verts: mesh.verts.size, faces: mesh.faces.size };
    // Role query, not getByLabelText: the label also holds the checked glyph.
    await userEvent.click(screen.getByRole('checkbox', { name: 'KEEP SHAPE' }));
    await userEvent.click(button('RELAX'));

    expect(mesh.verts.size).toBe(before.verts);
    expect(mesh.faces.size).toBe(before.faces);
    expect(corner.co.x).toBeLessThan(4);
  });
});
