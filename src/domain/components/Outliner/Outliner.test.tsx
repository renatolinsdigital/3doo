import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { Outliner } from './Outliner';

function resetStore() {
  useEditorStore.getState().resetScene();
}

describe('Outliner', () => {
  beforeEach(resetStore);

  it('prompts when the scene is empty', () => {
    render(<Outliner />);
    expect(screen.getByText(/No objects/i)).toBeInTheDocument();
  });

  it('lists the objects in the scene', () => {
    useEditorStore.getState().addPrimitive('box');
    useEditorStore.getState().addPrimitive('uvSphere');

    render(<Outliner />);

    expect(screen.getByRole('button', { name: 'BOX' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'UV SPHERE' })).toBeInTheDocument();
  });

  it('makes a clicked object active', async () => {
    useEditorStore.getState().addPrimitive('box');
    useEditorStore.getState().addPrimitive('cylinder');
    render(<Outliner />);

    await userEvent.click(screen.getByRole('button', { name: 'BOX' }));

    const state = useEditorStore.getState();
    const box = state.objects.find((object) => object.name === 'BOX');
    expect(state.activeObjectId).toBe(box?.id);
  });

  it('toggles visibility from the row', async () => {
    useEditorStore.getState().addPrimitive('box');
    render(<Outliner />);

    await userEvent.click(screen.getByRole('button', { name: 'Hide BOX' }));

    expect(useEditorStore.getState().objects[0].visible).toBe(false);
  });

  it('toggles the lock from the row', async () => {
    useEditorStore.getState().addPrimitive('box');
    render(<Outliner />);

    await userEvent.click(screen.getByRole('button', { name: 'Lock BOX' }));

    expect(useEditorStore.getState().objects[0].locked).toBe(true);
  });

  it('renames on double click', async () => {
    useEditorStore.getState().addPrimitive('box');
    render(<Outliner />);

    await userEvent.dblClick(screen.getByRole('button', { name: 'BOX' }));
    const input = screen.getByDisplayValue('BOX');
    await userEvent.clear(input);
    await userEvent.type(input, 'CHASSIS{Enter}');

    expect(useEditorStore.getState().objects[0].name).toBe('CHASSIS');
  });

  describe('locked-edit feedback', () => {
    afterEach(() => vi.useRealTimers());

    it('trembles the lock icon for 1s once a lockedAttempt reports this object, then settles', () => {
      useEditorStore.getState().addPrimitive('box');
      const id = useEditorStore.getState().objects[0].id;
      render(<Outliner />);

      expect(screen.getByRole('button', { name: 'Lock BOX' }).className).not.toMatch(/tremble/);

      vi.useFakeTimers();
      act(() => useEditorStore.setState({ lockedAttempt: { objectId: id, token: 1 } }));
      expect(screen.getByRole('button', { name: 'Lock BOX' }).className).toMatch(/tremble/);

      // Still shaking most of the way through the 1s run.
      act(() => vi.advanceTimersByTime(900));
      expect(screen.getByRole('button', { name: 'Lock BOX' }).className).toMatch(/tremble/);

      act(() => vi.advanceTimersByTime(100));
      expect(screen.getByRole('button', { name: 'Lock BOX' }).className).not.toMatch(/tremble/);
    });

    it('trembles when a locked object is clicked in the outliner', async () => {
      useEditorStore.getState().addPrimitive('box');
      useEditorStore.getState().toggleObjectLock(useEditorStore.getState().objects[0].id);
      render(<Outliner />);

      await userEvent.click(screen.getByRole('button', { name: 'BOX' }));

      expect(screen.getByRole('button', { name: 'Unlock BOX' }).className).toMatch(/tremble/);
      expect(useEditorStore.getState().status).toBe('Object is locked');
    });

    it('leaves an unlocked object alone when it is clicked', async () => {
      useEditorStore.getState().addPrimitive('box');
      render(<Outliner />);

      await userEvent.click(screen.getByRole('button', { name: 'BOX' }));

      expect(screen.getByRole('button', { name: 'Lock BOX' }).className).not.toMatch(/tremble/);
    });

    it('does not tremble for a lockedAttempt on a different object', () => {
      useEditorStore.getState().addPrimitive('box');
      render(<Outliner />);

      const lockBtn = screen.getByRole('button', { name: 'Lock BOX' });
      act(() => useEditorStore.setState({ lockedAttempt: { objectId: 'someone-else', token: 1 } }));

      expect(lockBtn.className).not.toMatch(/tremble/);
    });
  });
});
