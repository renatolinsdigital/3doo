import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('counts the points of a knife cut, and says Enter makes it', () => {
    useEditorStore.getState().addPrimitive('cube');
    act(() => {
      useEditorStore.getState().beginModal('knife');
      useEditorStore.getState().updateModal({ value: { x: 3, y: 0, z: 0 } });
    });

    render(<StatusBar />);

    const line = screen.getByRole('status');
    expect(line).toHaveTextContent('KNIFE 3 POINTS');
    expect(line).toHaveTextContent('Enter cut');
    // A click adds a point to the cut rather than confirming it.
    expect(line).not.toHaveTextContent('LMB confirm');
  });

  it('counts a knife cut of one point as one point', () => {
    useEditorStore.getState().addPrimitive('cube');
    act(() => {
      useEditorStore.getState().beginModal('knife');
      useEditorStore.getState().updateModal({ value: { x: 1, y: 0, z: 0 } });
    });

    render(<StatusBar />);

    expect(screen.getByRole('status')).toHaveTextContent('KNIFE 1 POINT:');
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

describe('the autosave disk', () => {
  const disk = () => document.querySelector('.status-bar__save--on');

  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.getState().resetScene();
  });

  afterEach(() => vi.useRealTimers());

  it('turns once a write has landed, then takes itself back off', () => {
    render(<StatusBar />);
    expect(disk()).toBeNull();

    act(() => useEditorStore.getState().noteAutosaved());
    expect(disk()).not.toBeNull();

    // Still turning most of the way through.
    act(() => vi.advanceTimersByTime(2400));
    expect(disk()).not.toBeNull();

    act(() => vi.advanceTimersByTime(200));
    expect(disk()).toBeNull();
  });

  it('starts over on the next write rather than sitting there', () => {
    render(<StatusBar />);

    act(() => useEditorStore.getState().noteAutosaved());
    act(() => vi.advanceTimersByTime(2000));
    // A second write lands while the first disk is still up: the turn has to
    // run again from the top, not finish on the first one's clock.
    act(() => useEditorStore.getState().noteAutosaved());
    act(() => vi.advanceTimersByTime(2000));

    // Past where the first turn would have ended, and still up.
    expect(disk()).not.toBeNull();
  });

  it('shows nothing on a bar that has only just arrived', () => {
    // A bar mounting into a session that has been writing for an hour has
    // missed those writes rather than witnessed them, so it must not report
    // the last one as if it had just happened.
    act(() => useEditorStore.getState().noteAutosaved());
    act(() => useEditorStore.getState().noteAutosaved());

    render(<StatusBar />);
    act(() => vi.advanceTimersByTime(100));

    expect(disk()).toBeNull();
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
