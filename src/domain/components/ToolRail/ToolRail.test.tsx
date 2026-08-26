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

  it('picking a shape picks the select tool up with it', async () => {
    useEditorStore.getState().setActiveTool('move');
    render(<ToolRail />);

    await userEvent.click(screen.getByRole('button', { name: /Select/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'CIRCLE' }));

    expect(useEditorStore.getState().activeTool).toBe('select');
  });
});
