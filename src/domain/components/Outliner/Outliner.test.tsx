import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

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
});
