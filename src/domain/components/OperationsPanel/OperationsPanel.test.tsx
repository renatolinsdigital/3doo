import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dot } from '@kernel/index';
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

describe('OperationsPanel', () => {
  beforeEach(() => {
    editBox();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disables every operation the current selection cannot feed', () => {
    render(<OperationsPanel />);

    for (const name of [
      'EXTRUDE',
      'INSET',
      'BEVEL',
      'LOOP CUT',
      'SUBDIVIDE',
      'MERGE',
      'CONNECT',
      'FILL',
      'BRIDGE',
      'GROW',
      'SHRINK',
      'FACE LOOP',
    ]) {
      expect(button(name)).toHaveAttribute('aria-disabled', 'true');
    }

    // These three fall back to the whole mesh, so they always have work to do.
    for (const name of ['MERGE BY DISTANCE…', 'TRIANGULATE', 'TRIS TO QUADS']) {
      expect(button(name)).not.toHaveAttribute('aria-disabled');
    }
  });

  it('enables them again once there is something to act on', () => {
    render(<OperationsPanel />);

    act(() => {
      activeMesh().selectAll();
      useEditorStore.getState().touchMesh();
    });

    for (const name of ['EXTRUDE', 'INSET', 'BEVEL', 'LOOP CUT', 'SUBDIVIDE', 'FILL', 'BRIDGE']) {
      expect(button(name)).not.toHaveAttribute('aria-disabled');
    }
    expect(button('MERGE')).not.toHaveAttribute('aria-disabled');
    // Connect runs one edge between two vertices; a whole cube is not that.
    expect(button('CONNECT')).toHaveAttribute('aria-disabled', 'true');
  });

  it('enables connect on exactly two vertices', () => {
    render(<OperationsPanel />);

    act(() => {
      const mesh = activeMesh();
      mesh.deselectAll();
      const [first, second] = [...mesh.verts.values()];
      mesh.selectVert(first);
      mesh.selectVert(second);
      mesh.flushSelection('vertex');
      useEditorStore.getState().touchMesh();
    });

    expect(button('CONNECT')).not.toHaveAttribute('aria-disabled');
  });

  /** Selects the two faces the given picker returns, in face mode. */
  function selectFaces(pick: (mesh: ReturnType<typeof activeMesh>) => unknown[]) {
    act(() => {
      const mesh = activeMesh();
      mesh.deselectAll();
      for (const face of pick(mesh) as { selected: boolean }[]) face.selected = true;
      mesh.flushSelection('face');
      useEditorStore.getState().setSelectMode('face');
      useEditorStore.getState().touchMesh();
    });
  }

  it('offers a face loop once two faces that touch are selected', () => {
    render(<OperationsPanel />);

    selectFaces((mesh) => {
      const [first] = [...mesh.faces.values()];
      const neighbour = mesh
        .faceEdges(first)
        .flatMap((edge) => mesh.edgeFaces(edge))
        .find((face) => face !== first);
      return [first, neighbour];
    });

    expect(button('FACE LOOP')).not.toHaveAttribute('aria-disabled');

    // A face loop is named by two adjacent faces; the other modes have no pair
    // of faces to read it from.
    act(() => {
      useEditorStore.getState().setSelectMode('edge');
    });

    expect(button('FACE LOOP')).toHaveAttribute('aria-disabled', 'true');
  });

  it('refuses two faces that do not touch, however many are selected', () => {
    render(<OperationsPanel />);

    // Opposite sides of a box: two faces, no shared edge, so no loop runs
    // through them. A count alone would have called this available.
    selectFaces((mesh) => {
      const [first] = [...mesh.faces.values()];
      const opposite = [...mesh.faces.values()].find(
        (face) => dot(face.normal, first.normal) < -0.99,
      );
      return [first, opposite];
    });

    expect(button('FACE LOOP')).toHaveAttribute('aria-disabled', 'true');
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
