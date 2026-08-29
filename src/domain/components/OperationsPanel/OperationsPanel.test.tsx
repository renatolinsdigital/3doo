import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subdivideFaces } from '@kernel/index';
import { TooltipHost } from '@shared/components';
import { useEditorStore } from '@store/index';

import { OperationsPanel } from './OperationsPanel';

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

const OPERATIONS = ['EXTRUDE', 'INSET', 'BEVEL', 'LOOP CUT', 'SUBDIVIDE'];

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

describe('OperationsPanel', () => {
  beforeEach(() => {
    editBox();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disables every operation the current selection cannot feed', () => {
    render(<OperationsPanel />);

    for (const name of OPERATIONS) {
      expect(button(name)).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('enables them again once there is something to act on', () => {
    render(<OperationsPanel />);

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
    render(<OperationsPanel />);
    await setSubdivideCuts('16');

    // 3,750 faces at sixteen cuts is over a million: refused outright, and the
    // button says why rather than leaving the user to find out.
    expect(button('SUBDIVIDE')).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button('SUBDIVIDE'));
    expect(activeMesh().faces.size).toBe(3750);
  });

  it('says how big a heavy subdivision is before running it', async () => {
    denseBox();
    render(<OperationsPanel />);
    await setSubdivideCuts('4');

    await userEvent.click(button('SUBDIVIDE'));

    // Nothing has run yet: the warning stands between the click and the work.
    expect(activeMesh().faces.size).toBe(3750);
    const warning = screen.getByRole('dialog');
    expect(warning).toHaveTextContent('93,750');

    await userEvent.click(within(warning).getByRole('button', { name: 'SUBDIVIDE ANYWAY' }));
    expect(activeMesh().faces.size).toBe(93750);
  });

  it('still shows the hint of a disabled operation, saying what to select', () => {
    render(
      <>
        <OperationsPanel />
        <TooltipHost />
      </>,
    );

    vi.useFakeTimers();
    fireEvent.mouseEnter(button('BEVEL'));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByRole('tooltip')).toHaveTextContent(/chamfers edges — select some first/i);
  });
});
