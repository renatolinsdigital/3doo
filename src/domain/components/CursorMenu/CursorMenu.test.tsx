import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { CursorMenu } from './CursorMenu';

/** Opens the menu with no snap target found, the way a click on empty space does. */
function openMenu() {
  act(() => {
    useEditorStore.getState().openCursorMenu({
      x: 10,
      y: 10,
      targets: { point: null, vertex: null, edge: null, face: null },
    });
  });
}

/** The hint an entry raises, which the tooltip host reads out of the store. */
function hintFor(name: string): string {
  fireEvent.focus(screen.getByRole('menuitem', { name }));
  return useEditorStore.getState().hint?.text ?? '';
}

describe('CursorMenu', () => {
  beforeEach(() => useEditorStore.getState().resetScene());

  it('sends the cursor to the origin and to the geometry from two entries', async () => {
    const store = useEditorStore.getState();
    store.addPrimitive('box');
    // An edit-mode move: the mesh travels, the origin stays where it was.
    for (const vert of useEditorStore.getState().objects[0].mesh.verts.values()) {
      vert.co = { ...vert.co, y: vert.co.y + 3 };
    }
    store.touchMesh();

    openMenu();
    render(<CursorMenu />);
    await userEvent.click(screen.getByRole('menuitem', { name: 'CURSOR TO SELECTION ORIGIN' }));
    expect(useEditorStore.getState().cursor.y).toBeCloseTo(0);

    openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'CURSOR TO SELECTION' }));
    expect(useEditorStore.getState().cursor.y).toBeCloseTo(3);
  });

  it('names the keys the editor actually answers to', () => {
    openMenu();
    render(<CursorMenu />);

    // Written out by hand these drifted: the menu spent a while offering
    // CTRL+SHIFT+V for a snap bound to nothing, and for one bound to
    // CTRL+SHIFT+C. They are read off the keymap now.
    expect(hintFor('CURSOR TO SELECTION')).toContain('(CTRL+SHIFT+C)');
    expect(hintFor('SELECTION TO CURSOR')).toContain('(SHIFT+V)');
    expect(hintFor('CURSOR TO WORLD ORIGIN')).toContain('(SHIFT+C)');
    // Bound to nothing, so it claims nothing rather than inventing a key.
    expect(hintFor('CURSOR TO VERTEX')).not.toContain('(');
  });
});
