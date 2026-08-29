import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const OPERATIONS = ['EXTRUDE', 'INSET', 'BEVEL'];

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
