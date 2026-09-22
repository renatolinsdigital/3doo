import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipHost } from '@shared/components';
import { useEditorStore } from '@store/index';

import { OperationsPanel } from './OperationsPanel';

/** The real operator runner, put back after the test that stubs it out. */
const realExec = useEditorStore.getState().exec;

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

const OPERATIONS = ['EXTRUDE', 'INSET', 'BEVEL'];

describe('OperationsPanel', () => {
  beforeEach(() => {
    editBox();
  });

  afterEach(() => {
    vi.useRealTimers();
    // In act, since the panel reads exec straight off the store: putting the
    // real one back re-renders whatever is still mounted at this point.
    act(() => useEditorStore.setState({ exec: realExec }));
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

  it('bevels by the width the field is set to, not a fixed one', async () => {
    // The whole reason bevel is here and not a one-click button in the rail:
    // a chamfer is the width it is given, and a button can only ever run one.
    const exec = vi.fn();
    useEditorStore.setState({ exec });
    act(() => {
      activeMesh().selectAll();
      useEditorStore.getState().touchMesh();
    });
    render(<OperationsPanel />);

    const width = screen.getByLabelText('WIDTH');
    await userEvent.clear(width);
    await userEvent.type(width, '0.35{Enter}');
    await userEvent.click(button('BEVEL'));

    expect(exec).toHaveBeenCalledWith('bevel', { width: 0.35, segments: 1 }, 'Bevel');
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

    expect(screen.getByRole('tooltip')).toHaveTextContent(/chamfers edges, so select some first/i);
  });
});
