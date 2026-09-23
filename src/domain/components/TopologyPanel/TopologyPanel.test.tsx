import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { type Vert, distance, dot } from '@kernel/index';
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

/** The slide row sits switched off until it is asked for. */
function enableSlide() {
  return userEvent.click(screen.getByRole('checkbox', { name: 'ENABLE' }));
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
      'VERTEX SLIDE',
      'EDGE SLIDE',
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

  /** Selects the vertices the picker returns, in vertex mode. */
  function selectVerts(pick: (mesh: ReturnType<typeof activeMesh>) => Vert[]) {
    act(() => {
      const mesh = activeMesh();
      mesh.deselectAll();
      for (const vert of pick(mesh)) mesh.selectVert(vert);
      mesh.flushSelection('vertex');
      useEditorStore.getState().setSelectMode('vertex');
      useEditorStore.getState().touchMesh();
    });
  }

  it('slides a selected vertex as far as the panel is set to', async () => {
    render(<TopologyPanel />);
    const [vert] = [...activeMesh().verts.values()];
    const from = { ...vert.co };

    selectVerts(() => [vert]);
    await enableSlide();
    expect(button('VERTEX SLIDE')).not.toHaveAttribute('aria-disabled');
    // An edge slide reads the faces beside a selected edge, which vertex
    // select mode has not picked.
    expect(button('EDGE SLIDE')).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(button('VERTEX SLIDE'));

    expect(distance(vert.co, from)).toBeCloseTo(0.1, 6);
  });

  it('slides a selected edge across the face beside it', async () => {
    render(<TopologyPanel />);
    const edge = [...activeMesh().edges.values()][0];
    const from = { ...edge.v0.co };

    selectEdges(() => [edge]);
    await enableSlide();
    expect(button('EDGE SLIDE')).not.toHaveAttribute('aria-disabled');
    expect(button('VERTEX SLIDE')).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(button('EDGE SLIDE'));

    expect(distance(edge.v0.co, from)).toBeCloseTo(0.1, 6);
  });

  it('draws the vertex where the slide would leave it, and goes with the panel', async () => {
    const view = render(<TopologyPanel />);
    const [vert] = [...activeMesh().verts.values()];

    selectVerts(() => [vert]);
    await enableSlide();
    const landed = useEditorStore.getState().slidePreview?.points ?? [];
    // The panel opens at a tenth of a metre, which is how far down the edge the
    // dot sits. The vertex itself has not moved.
    expect(landed).toHaveLength(1);
    expect(distance(landed[0], vert.co)).toBeCloseTo(0.1, 6);

    // A second direction is a different edge out of the same vertex, so the
    // dot lands somewhere else entirely.
    await userEvent.selectOptions(screen.getByLabelText('DIRECTION'), '2');
    const turned = useEditorStore.getState().slidePreview?.points ?? [];
    expect(turned[0]).not.toEqual(landed[0]);
    expect(distance(turned[0], vert.co)).toBeCloseTo(0.1, 6);

    view.unmount();
    expect(useEditorStore.getState().slidePreview).toBeNull();
  });

  it('draws the selected edge where the slide would land it', async () => {
    render(<TopologyPanel />);
    const edge = [...activeMesh().edges.values()][0];

    selectEdges(() => [edge]);
    await enableSlide();

    const preview = useEditorStore.getState().slidePreview;
    const points = preview?.points ?? [];
    const [from, to] = preview?.segments[0] ?? [0, 0];
    // Both ends travel, so the preview is the selected edge itself, drawn a
    // tenth of a metre across the face beside it.
    expect(preview?.segments).toHaveLength(1);
    expect(distance(points[from], edge.v0.co)).toBeCloseTo(0.1, 6);
    expect(distance(points[to], edge.v1.co)).toBeCloseTo(0.1, 6);
  });

  it('keeps the row and its preview down until the switch is on', async () => {
    render(<TopologyPanel />);
    const [vert] = [...activeMesh().verts.values()];

    selectVerts(() => [vert]);
    // A selection the slide could run on, and still nothing over the mesh: the
    // preview marks a slide being set up, not one that could be.
    expect(useEditorStore.getState().slidePreview).toBeNull();
    expect(button('VERTEX SLIDE')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('DIRECTION')).toBeDisabled();

    await enableSlide();
    expect(useEditorStore.getState().slidePreview).not.toBeNull();
    expect(button('VERTEX SLIDE')).not.toHaveAttribute('aria-disabled');
    expect(screen.getByLabelText('DIRECTION')).not.toBeDisabled();

    await enableSlide();
    expect(useEditorStore.getState().slidePreview).toBeNull();
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
