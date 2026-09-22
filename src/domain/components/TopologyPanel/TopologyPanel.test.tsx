import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { dot } from '@kernel/index';
import { useEditorStore } from '@store/index';

import { TopologyPanel } from './TopologyPanel';

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

describe('TopologyPanel', () => {
  beforeEach(() => {
    editBox();
  });

  it('disables every operation the current selection cannot feed', () => {
    render(<TopologyPanel />);

    for (const name of [
      'CONNECT',
      'FILL',
      'BRIDGE',
      'MERGE',
      'GROW',
      'SHRINK',
      'EDGE LOOP',
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
    render(<TopologyPanel />);

    act(() => {
      activeMesh().selectAll();
      useEditorStore.getState().touchMesh();
    });

    for (const name of ['FILL', 'BRIDGE', 'MERGE', 'GROW', 'SHRINK']) {
      expect(button(name)).not.toHaveAttribute('aria-disabled');
    }
    // Connect runs one edge between two vertices; a whole cube is not that.
    expect(button('CONNECT')).toHaveAttribute('aria-disabled', 'true');
  });

  it('enables connect on exactly two vertices', () => {
    render(<TopologyPanel />);

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
    render(<TopologyPanel />);

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

  /** Selects the edges the picker returns, in edge mode. */
  function selectEdges(pick: (mesh: ReturnType<typeof activeMesh>) => unknown[]) {
    act(() => {
      const mesh = activeMesh();
      mesh.deselectAll();
      for (const edge of pick(mesh) as { selected: boolean }[]) edge.selected = true;
      mesh.flushSelection('edge');
      useEditorStore.getState().setSelectMode('edge');
      useEditorStore.getState().touchMesh();
    });
  }

  it('offers an edge loop once two edges that meet are selected', () => {
    render(<TopologyPanel />);

    selectEdges((mesh) => {
      const [first] = [...mesh.edges.values()];
      const touching = [...mesh.edges.values()].find(
        (edge) => edge !== first && (edge.v0 === first.v0 || edge.v1 === first.v0),
      );
      return [first, touching];
    });

    expect(button('EDGE LOOP')).not.toHaveAttribute('aria-disabled');

    // An edge loop is named by two edges that meet; face mode has none to read.
    act(() => {
      useEditorStore.getState().setSelectMode('face');
    });

    expect(button('EDGE LOOP')).toHaveAttribute('aria-disabled', 'true');
  });

  it('refuses two edges that never meet, however many are selected', () => {
    render(<TopologyPanel />);

    // Opposite sides of a box: two edges, no shared vertex, so neither says
    // which loop the other belongs to. A count alone would have called this
    // available.
    selectEdges((mesh) => {
      const [first] = [...mesh.edges.values()];
      const apart = [...mesh.edges.values()].find(
        (edge) =>
          edge.v0 !== first.v0 &&
          edge.v1 !== first.v0 &&
          edge.v0 !== first.v1 &&
          edge.v1 !== first.v1,
      );
      return [first, apart];
    });

    expect(button('EDGE LOOP')).toHaveAttribute('aria-disabled', 'true');
  });

  it('refuses two faces that do not touch, however many are selected', () => {
    render(<TopologyPanel />);

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
});
