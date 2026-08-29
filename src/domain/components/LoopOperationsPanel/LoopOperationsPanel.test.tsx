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
  store.addPrimitive('box');
  store.setMode('edit');
}

function button(name: string) {
  return screen.getByRole('button', { name });
}

const OPERATIONS = ['LOOP CUT', 'SUBDIVIDE', 'RELAX'];

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

  it('relaxes the selection without adding or removing geometry', async () => {
    render(<LoopOperationsPanel />);

    const mesh = activeMesh();
    // One corner dragged off the cube into a spike. Keeping the shape would
    // leave it where it is — a spike is part of the surface, and relax slides
    // along the surface — so the test turns that off and watches it come back.
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
