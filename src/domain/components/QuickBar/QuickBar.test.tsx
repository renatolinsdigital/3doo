import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { QuickBar, type QuickBarProps } from './QuickBar';

function renderBar(props: Partial<QuickBarProps> = {}) {
  const handlers = { onToggleTools: vi.fn(), onToggleScene: vi.fn() };
  render(
    <QuickBar
      drawers
      touch
      toolsOpen={false}
      sceneOpen={false}
      hasTools
      hasScene
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('QuickBar', () => {
  beforeEach(() => {
    useEditorStore.getState().resetScene();
    useEditorStore.setState({
      mode: 'object',
      modal: null,
      selectExtend: false,
      modalCommandRequest: null,
      hint: null,
    });
  });

  it('opens the drawers, saying which column each one controls', async () => {
    const { onToggleTools, onToggleScene } = renderBar({ sceneOpen: true });

    const tools = screen.getByRole('button', { name: 'TOOLS' });
    const scene = screen.getByRole('button', { name: 'SCENE' });
    expect(tools).toHaveAttribute('aria-expanded', 'false');
    expect(tools).toHaveAttribute('aria-controls', 'modeling-tools');
    expect(scene).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(tools);
    await userEvent.click(scene);
    expect(onToggleTools).toHaveBeenCalledOnce();
    expect(onToggleScene).toHaveBeenCalledOnce();
  });

  it('leaves the drawer buttons out where the columns are not drawers', () => {
    renderBar({ drawers: false });
    expect(screen.queryByRole('button', { name: 'TOOLS' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('leaves the keyboard stand-ins out where there is a mouse', () => {
    renderBar({ touch: false });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ADD' })).toBeNull();
  });

  it('turns the ADD switch on and off, the way holding Shift would', async () => {
    renderBar();
    const add = screen.getByRole('button', { name: 'ADD' });

    await userEvent.click(add);
    expect(useEditorStore.getState().selectExtend).toBe(true);
    expect(add).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(add);
    expect(useEditorStore.getState().selectExtend).toBe(false);
  });

  it('undoes and redoes, and says when there is nothing to go back to', async () => {
    renderBar();
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo).toHaveAttribute('aria-disabled', 'true');

    act(() => useEditorStore.getState().addPrimitive('cube'));
    expect(undo).not.toHaveAttribute('aria-disabled');
    const count = useEditorStore.getState().objects.length;

    await userEvent.click(undo);
    expect(useEditorStore.getState().objects.length).toBe(count - 1);

    await userEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(useEditorStore.getState().objects.length).toBe(count);
  });

  it('deletes the selected objects in object mode', async () => {
    useEditorStore.getState().addPrimitive('cube');
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(useEditorStore.getState().objects).toHaveLength(0);
  });

  it('opens the delete menu in edit mode, where there is more than one way to delete', async () => {
    useEditorStore.getState().addPrimitive('cube');
    useEditorStore.getState().setMode('edit');
    renderBar();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(useEditorStore.getState().deleteMenuRequest).not.toBeNull();
  });

  it('finishes a knife cut from its own buttons, which a press during a cut lets through', async () => {
    useEditorStore.setState({
      modal: {
        kind: 'knife',
        axis: null,
        excludeAxis: false,
        typed: '',
        value: { x: 1, y: 0, z: 0 },
      },
    });
    renderBar();

    const cut = screen.getByRole('button', { name: 'CUT' });
    const back = screen.getByRole('button', { name: 'UNDO POINT' });
    const cancel = screen.getByRole('button', { name: 'CANCEL' });
    for (const button of [cut, back, cancel]) expect(button).toHaveAttribute('data-modal-control');

    await userEvent.click(back);
    expect(useEditorStore.getState().modalCommandRequest?.command).toBe('back');
    await userEvent.click(cancel);
    expect(useEditorStore.getState().modalCommandRequest?.command).toBe('cancel');
    await userEvent.click(cut);
    expect(useEditorStore.getState().modalCommandRequest?.command).toBe('confirm');
  });

  it('offers confirm and cancel for any other modal, with no point to take back', () => {
    useEditorStore.setState({
      modal: {
        kind: 'scale',
        axis: null,
        excludeAxis: false,
        typed: '',
        value: { x: 1, y: 1, z: 1 },
      },
    });
    renderBar();

    expect(screen.getByRole('button', { name: 'CONFIRM' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'UNDO POINT' })).toBeNull();
  });
});
