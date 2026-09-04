import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { HistoryDialog } from './HistoryDialog';

const store = () => useEditorStore.getState();

describe('HistoryDialog', () => {
  beforeEach(() => {
    store().resetScene();
    store().setPreferences({ historySize: 50 });
    store().openDialog('history');
  });

  it('says so when there is nothing to go back to', () => {
    render(<HistoryDialog />);

    expect(screen.getByText(/nothing to go back to yet/i)).toBeInTheDocument();
    expect(screen.getByText(/0 of 50 steps kept/i)).toBeInTheDocument();
  });

  it('lists the steps behind the scene, newest first', () => {
    store().addPrimitive('box');
    store().addPrimitive('cylinder');

    render(<HistoryDialog />);

    const steps = within(screen.getByRole('list'))
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(steps[0]).toContain('Add CYLINDER');
    expect(steps[1]).toContain('Add BOX');
  });

  it('travels to the step that was clicked rather than one at a time', async () => {
    store().addPrimitive('box');
    store().addPrimitive('cylinder');
    store().addPrimitive('cone');

    render(<HistoryDialog />);
    await userEvent.click(screen.getByRole('button', { name: /Add BOX/ }));

    // Three steps in one click: the scene as it stood before the box arrived.
    expect(store().objects).toHaveLength(0);
    expect(store().historyRedo).toEqual(['Add BOX', 'Add CYLINDER', 'Add CONE']);
  });

  it('offers the steps ahead again once one has been taken back', async () => {
    store().addPrimitive('box');
    store().undo();

    render(<HistoryDialog />);
    await userEvent.click(screen.getByRole('button', { name: /Add BOX/ }));

    expect(store().objects).toHaveLength(1);
  });

  it('counts a step ahead from the present, not from the far end of the list', async () => {
    store().addPrimitive('box');
    store().addPrimitive('cylinder');
    store().addPrimitive('cone');
    store().undoTimes(3);

    render(<HistoryDialog />);
    const rows = within(screen.getByRole('list'))
      .getAllByRole('button')
      .map((button) => button.textContent);
    // Furthest ahead at the top, the nearest step just above NOW.
    expect(rows[0]).toContain('Add CONE3 forward');
    expect(rows[2]).toContain('Add BOX1 forward');

    await userEvent.click(screen.getByRole('button', { name: /Add CYLINDER/ }));

    // Two forward is the box and the cylinder, and not the cone behind them.
    expect(store().objects).toHaveLength(2);
    expect(store().historyRedo).toEqual(['Add CONE']);
  });

  it('stays open while travelling, so a trip too far is one click back', async () => {
    store().addPrimitive('box');

    render(<HistoryDialog />);
    await userEvent.click(screen.getByRole('button', { name: /Add BOX/ }));

    expect(store().dialog).toBe('history');
    expect(screen.getByRole('button', { name: /Add BOX/ })).toBeInTheDocument();
  });
});
