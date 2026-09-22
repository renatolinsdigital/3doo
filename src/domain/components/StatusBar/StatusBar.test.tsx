import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { StatusBar } from './StatusBar';

describe('StatusBar', () => {
  beforeEach(() => useEditorStore.getState().resetScene());

  it('reads a live rotation out in degrees', () => {
    useEditorStore.getState().addPrimitive('cube');
    act(() => {
      useEditorStore.getState().beginModal('rotate');
      useEditorStore.getState().updateModal({ value: { x: 42.5, y: 0, z: 0 } });
    });

    render(<StatusBar />);

    expect(screen.getByRole('status')).toHaveTextContent('ROTATE 42.5°');
  });

  it('names the axis a rotation has been pinned to', () => {
    useEditorStore.getState().addPrimitive('cube');
    act(() => {
      useEditorStore.getState().beginModal('rotate');
      useEditorStore.getState().updateModal({ axis: 'z', value: { x: -90, y: 0, z: 0 } });
    });

    render(<StatusBar />);

    // The angle stays in x whatever axis the turn is about: there is one angle,
    // not three.
    expect(screen.getByRole('status')).toHaveTextContent('ROTATE Z -90.0°');
  });

  it('says what a slide is moving, and how far along it is', () => {
    useEditorStore.getState().addPrimitive('cube');
    act(() => {
      useEditorStore.getState().beginModal('slide', 'edge');
      useEditorStore.getState().updateModal({ value: { x: -0.42, y: 0, z: 0 } });
    });

    render(<StatusBar />);

    expect(screen.getByRole('status')).toHaveTextContent('SLIDE EDGE -0.420');
  });

  it('reads out how wide a bevel has been dragged so far', () => {
    useEditorStore.getState().addPrimitive('cube');
    act(() => {
      useEditorStore.getState().beginModal('bevel');
      useEditorStore.getState().updateModal({ value: { x: 0.125, y: 0, z: 0 } });
    });

    render(<StatusBar />);

    // One distance, carried in x the way a rotation carries its one angle.
    expect(screen.getByRole('status')).toHaveTextContent('BEVEL 0.125');
  });

  it('flags auto merge while it is switched on', () => {
    useEditorStore.getState().setAutoMerge({ enabled: true, threshold: 0.02 });

    render(<StatusBar />);

    // A setting that quietly removes vertices has to say it is in force.
    expect(screen.getByText('MERGE 0.020')).toBeInTheDocument();
  });

  it('reports an empty scene', () => {
    render(<StatusBar />);
    expect(screen.getByText('OBJ')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('New project');
  });

  it('counts geometry from the kernel', () => {
    useEditorStore.getState().addPrimitive('cube');

    render(<StatusBar />);

    // A cube: 8 verts, 12 edges, 6 faces, 12 tris.
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    const twelves = screen.getAllByText('12');
    expect(twelves).toHaveLength(2);
  });

  it('shows the current mode', () => {
    useEditorStore.getState().addPrimitive('cube');
    useEditorStore.getState().setMode('edit');

    render(<StatusBar />);

    expect(screen.getByText('EDIT / VERTEX')).toBeInTheDocument();
  });

  it('reads out a live scale factor while S is running', () => {
    useEditorStore.getState().addPrimitive('cube');
    useEditorStore.getState().beginModal('scale');

    const { rerender } = render(<StatusBar />);
    // Starts at the identity, not at zero.
    expect(screen.getByRole('status')).toHaveTextContent('SCALE ×1.000');

    act(() => useEditorStore.getState().updateModal({ axis: 'x', value: { x: 2, y: 1, z: 1 } }));
    rerender(<StatusBar />);

    expect(screen.getByRole('status')).toHaveTextContent('SCALE X ×2.000');
    expect(screen.getByRole('status')).toHaveTextContent('Esc cancel');
  });

  it('shows snap state as text, not just colour', () => {
    render(<StatusBar />);
    expect(screen.getByText('SNAP OFF')).toBeInTheDocument();

    act(() => useEditorStore.getState().setPreferences({ snapEnabled: true, snapMode: 'grid' }));

    expect(screen.getByText('SNAP GRID')).toBeInTheDocument();

    act(() => useEditorStore.getState().setPreferences({ snapMode: 'custom', snapStep: 0.03 }));

    expect(screen.getByText('SNAP 0.03 GRID')).toBeInTheDocument();
  });
});

describe('progress readout', () => {
  it('shows the percentage and the operation while one is running', () => {
    act(() => useEditorStore.setState({ progress: { label: 'UNION', value: 0.9 } }));
    render(<StatusBar />);

    const bar = screen.getByRole('progressbar', { name: 'UNION' });
    expect(bar).toHaveAttribute('aria-valuenow', '90');
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('UNION')).toBeInTheDocument();
  });

  it('gives the slot back to the status message once it is done', () => {
    act(() =>
      useEditorStore.setState({ progress: null, status: 'Union of 2 objects', modal: null }),
    );
    render(<StatusBar />);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('Union of 2 objects')).toBeInTheDocument();
  });

  it('rounds to whole percent and never reports past the ends', () => {
    for (const [value, shown] of [
      [0, '0%'],
      [0.666, '67%'],
      [1, '100%'],
      [1.4, '100%'],
      [-0.2, '0%'],
    ] as const) {
      act(() => useEditorStore.setState({ progress: { label: 'REMESH', value } }));
      const view = render(<StatusBar />);
      expect(screen.getByText(shown)).toBeInTheDocument();
      view.unmount();
    }
  });
});
