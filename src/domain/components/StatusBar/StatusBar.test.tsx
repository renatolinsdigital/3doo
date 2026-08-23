import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { StatusBar } from './StatusBar';

describe('StatusBar', () => {
  beforeEach(() => useEditorStore.getState().resetScene());

  it('reports an empty scene', () => {
    render(<StatusBar />);
    expect(screen.getByText('OBJ')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('New project');
  });

  it('counts geometry from the kernel', () => {
    useEditorStore.getState().addPrimitive('box');

    render(<StatusBar />);

    // A cube: 8 verts, 12 edges, 6 faces, 12 tris.
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    const twelves = screen.getAllByText('12');
    expect(twelves).toHaveLength(2);
  });

  it('shows the current mode', () => {
    useEditorStore.getState().addPrimitive('box');
    useEditorStore.getState().setMode('edit');

    render(<StatusBar />);

    expect(screen.getByText('EDIT / VERTEX')).toBeInTheDocument();
  });

  it('shows snap state as text, not just colour', () => {
    render(<StatusBar />);
    expect(screen.getByText('SNAP OFF')).toBeInTheDocument();

    act(() => useEditorStore.getState().setSnap({ enabled: true, mode: 'vertex' }));

    expect(screen.getByText('SNAP VERTEX')).toBeInTheDocument();
  });
});
