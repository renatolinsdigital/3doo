import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { ToolRail } from './ToolRail';

describe('ToolRail', () => {
  beforeEach(() => {
    useEditorStore.getState().resetScene();
  });

  it('opens the shape picker from the select tool', async () => {
    render(<ToolRail />);

    await userEvent.click(screen.getByRole('button', { name: /Select/ }));

    const menu = screen.getByRole('menu', { name: 'SELECT SHAPE' });
    for (const shape of ['SQUARE', 'CIRCLE', 'LASSO']) {
      expect(screen.getByRole('menuitem', { name: shape })).toBeInTheDocument();
    }
    expect(menu).toBeInTheDocument();
    // The shape in force is marked, not spelled out in its label.
    expect(screen.getByRole('menuitem', { name: 'SQUARE' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(useEditorStore.getState().activeTool).toBe('select');
  });

  it('arms the shape that was picked, and marks it next time', async () => {
    render(<ToolRail />);

    await userEvent.click(screen.getByRole('button', { name: /Select/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'LASSO' }));

    expect(useEditorStore.getState().selectShape).toBe('lasso');

    await userEvent.click(screen.getByRole('button', { name: /Select/ }));
    expect(screen.getByRole('menuitem', { name: 'LASSO' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('menuitem', { name: 'SQUARE' })).not.toHaveAttribute('aria-current');
  });

  it('leaves the operators that take a parameter to the panels', () => {
    useEditorStore.getState().setMode('edit');
    render(<ToolRail />);

    // Bevel wants a width and merge by distance a threshold, and a rail button
    // can only run one fixed value. Both are in the panels, where the number
    // is the user's to set: BEVEL under OPERATIONS, MERGE BY DISTANCE under
    // TOPOLOGY.
    expect(screen.queryByRole('button', { name: /Bevel/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Merge/ })).not.toBeInTheDocument();
  });

  it('recentres the origin without taking the active tool', async () => {
    const store = useEditorStore.getState();
    store.addPrimitive('cube');
    const object = useEditorStore.getState().objects[0];
    for (const vert of object.mesh.verts.values()) vert.co = { ...vert.co, y: vert.co.y + 3 };
    store.touchMesh();
    store.setActiveTool('move');

    render(<ToolRail />);
    await userEvent.click(screen.getByRole('button', { name: /Origin to geometry/ }));

    expect(useEditorStore.getState().objects[0].transform.position.y).toBeCloseTo(3);
    expect(useEditorStore.getState().activeTool).toBe('move');
  });

  it('picking a shape picks the select tool up with it', async () => {
    useEditorStore.getState().setActiveTool('move');
    render(<ToolRail />);

    await userEvent.click(screen.getByRole('button', { name: /Select/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'CIRCLE' }));

    expect(useEditorStore.getState().activeTool).toBe('select');
  });
});
