import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@app/App';
import { DEFAULT_REMESH_SETTINGS } from '@kernel/index';
import { useEditorStore } from '@store/index';

// The real viewport needs a WebGL context jsdom does not provide; every panel
// below is the real component.
vi.mock('@viewport/index', () => ({
  Viewport: class {
    resize() {}
    dispose() {}
  },
}));

/** The solve is deferred a macrotask so the panel can paint its busy state. */
async function remesh() {
  await userEvent.click(screen.getByRole('button', { name: 'REMESH' }));
  await waitFor(() => expect(useEditorStore.getState().remeshBusy).toBe(false));
}

function addBox() {
  act(() => {
    useEditorStore.getState().addPrimitive('box');
  });
}

describe('remesh module', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/remesh');
    useEditorStore.getState().resetScene();
    useEditorStore.setState({
      remesh: { ...DEFAULT_REMESH_SETTINGS, adaptive: false, voxelSize: 0.4 },
      remeshPreview: null,
      remeshReport: null,
      tooltipsEnabled: false,
    });
  });

  it('lays out the remesh panels over the same viewport', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: /3DOO - REMESH/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'PRESETS' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'TOPOLOGY' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'RESULT' })).toBeInTheDocument();
    // The scene panels the module shares with the editor.
    expect(screen.getByRole('region', { name: 'OUTLINER' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Tools' })).toBeInTheDocument();
  });

  it('drops back to object mode, since a remesh acts on whole objects', () => {
    addBox();
    act(() => {
      useEditorStore.getState().setMode('edit');
    });

    render(<App />);

    expect(useEditorStore.getState().mode).toBe('object');
  });

  it('refuses to run with nothing selected', async () => {
    render(<App />);

    const panel = screen.getByRole('region', { name: 'TOPOLOGY' });
    expect(within(panel).getByRole('button', { name: 'REMESH' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('rebuilds the active object and reports what changed', async () => {
    addBox();
    render(<App />);

    await remesh();

    const object = useEditorStore.getState().objects[0];
    expect(object.mesh.faces.size).toBeGreaterThan(6);

    const report = screen.getByRole('region', { name: 'RESULT' });
    expect(within(report).getByRole('row', { name: /FACES/ })).toHaveTextContent('6');
    expect(within(report).getByText(/uncommitted result/)).toBeInTheDocument();
  });

  it('keeps the result out of undo until it is applied', async () => {
    addBox();
    render(<App />);
    const original = useEditorStore.getState().objects[0].mesh;

    await remesh();
    expect(useEditorStore.getState().canUndo).toBe(true); // from adding the box

    await userEvent.click(screen.getByRole('button', { name: 'APPLY' }));
    expect(useEditorStore.getState().remeshPreview).toBeNull();

    act(() => {
      useEditorStore.getState().undo();
    });

    // Undo goes back to the box as it was, not to the box before it existed.
    expect(useEditorStore.getState().objects[0].mesh.faces.size).toBe(original.faces.size);
  });

  it('puts the original mesh back on revert', async () => {
    addBox();
    render(<App />);
    const original = useEditorStore.getState().objects[0].mesh;

    await remesh();
    expect(useEditorStore.getState().objects[0].mesh).not.toBe(original);

    await userEvent.click(screen.getByRole('button', { name: 'REVERT' }));

    expect(useEditorStore.getState().objects[0].mesh).toBe(original);
    expect(useEditorStore.getState().remeshPreview).toBeNull();
  });

  it('re-runs from the original mesh rather than from its own output', async () => {
    addBox();
    render(<App />);
    const original = useEditorStore.getState().objects[0].mesh;

    await remesh();
    const first = useEditorStore.getState().objects[0].mesh.faces.size;

    await userEvent.click(screen.getByRole('button', { name: 'RUN AGAIN' }));
    await waitFor(() => expect(useEditorStore.getState().remeshBusy).toBe(false));

    expect(useEditorStore.getState().objects[0].mesh.faces.size).toBe(first);
    expect(useEditorStore.getState().remeshPreview?.source).toBe(original);
  });

  it('swaps the density control when the method changes', async () => {
    render(<App />);
    const panel = screen.getByRole('region', { name: 'TOPOLOGY' });

    expect(within(panel).getByLabelText('VOXEL SIZE')).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole('button', { name: /REDUCE/ }));

    expect(within(panel).queryByLabelText('VOXEL SIZE')).not.toBeInTheDocument();
    expect(within(panel).getByLabelText('KEEP')).toBeInTheDocument();
    expect(within(panel).getByRole('checkbox', { name: 'PRESERVE BOUNDARY' })).toBeInTheDocument();
  });

  it('says what there is to work from', () => {
    addBox();
    render(<App />);

    const panel = screen.getByRole('region', { name: 'TOPOLOGY' });
    expect(within(panel).getByText(/BOX has 6 faces to work from/)).toBeInTheDocument();
  });

  it('warns before running when a reduce target is above the mesh', () => {
    addBox();
    useEditorStore.setState({
      remesh: {
        ...DEFAULT_REMESH_SETTINGS,
        method: 'decimate',
        adaptive: true,
        targetFaces: 200000,
      },
    });
    render(<App />);

    const panel = screen.getByRole('region', { name: 'TOPOLOGY' });
    expect(within(panel).getByText(/would collapse nothing/)).toBeInTheDocument();
  });

  it('leaves the mesh untouched when a reduce target collapses nothing', async () => {
    addBox();
    useEditorStore.setState({
      remesh: {
        ...DEFAULT_REMESH_SETTINGS,
        method: 'decimate',
        adaptive: true,
        targetFaces: 200000,
      },
    });
    render(<App />);
    const before = useEditorStore.getState().objects[0].mesh.faces.size;

    await remesh();

    expect(useEditorStore.getState().objects[0].mesh.faces.size).toBe(before);
  });

  it('applies a preset to the settings', async () => {
    render(<App />);
    const presets = screen.getByRole('region', { name: 'PRESETS' });

    await userEvent.click(within(presets).getByRole('button', { name: 'BLOCK OUT' }));

    expect(useEditorStore.getState().remesh.method).toBe('blocks');
  });

  it('reverts an uncommitted preview when the module is left', async () => {
    addBox();
    const view = render(<App />);
    const original = useEditorStore.getState().objects[0].mesh;

    await remesh();
    view.unmount();

    expect(useEditorStore.getState().objects[0].mesh).toBe(original);
  });

  it('refuses a mesh another object is linked to', async () => {
    addBox();
    act(() => {
      useEditorStore.getState().duplicateSelected(true);
    });
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'REMESH' }));

    expect(useEditorStore.getState().remeshPreview).toBeNull();
    const statusBar = screen.getByRole('contentinfo');
    expect(within(statusBar).getByRole('status')).toHaveTextContent('single-user');
  });
});
