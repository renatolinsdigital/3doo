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

/** The entries that have nothing to act on until something is selected. */
const NEEDS_SELECTION = [
  'CURSOR TO SELECTION',
  'CURSOR TO SELECTION ORIGIN',
  'SELECTION TO CURSOR',
  'ORIGIN OF SELECTED TO CURSOR',
];

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

  it('brings the origin of the selection to the cursor without moving the shape', async () => {
    const store = useEditorStore.getState();
    store.addPrimitive('box');
    store.setCursor({ x: 0, y: 4, z: 0 });

    openMenu();
    render(<CursorMenu />);
    await userEvent.click(screen.getByRole('menuitem', { name: 'ORIGIN OF SELECTED TO CURSOR' }));

    const object = useEditorStore.getState().objects[0];
    expect(object.transform.position.y).toBeCloseTo(4);
    expect(object.mesh.boundingBox().max.y).toBeCloseTo(-3.5);
  });

  it('names the keys the editor actually answers to', () => {
    // With a selection, so the entries that need one carry their real hint.
    act(() => useEditorStore.getState().addPrimitive('box'));
    openMenu();
    render(<CursorMenu />);

    // Written out by hand these drifted: the menu spent a while offering
    // CTRL+SHIFT+V for a snap bound to nothing, and for one bound to
    // CTRL+SHIFT+C. They are read off the keymap now.
    expect(hintFor('CURSOR TO SELECTION')).toContain('(CTRL+SHIFT+C)');
    expect(hintFor('SELECTION TO CURSOR')).toContain('(SHIFT+V)');
    expect(hintFor('CURSOR TO WORLD ORIGIN')).toContain('(SHIFT+C)');
    expect(hintFor('CURSOR TO VERTEX')).toContain('(ALT+V)');
  });

  it('names a key on every entry, disabled ones included', () => {
    // The snaps under the pointer are the ones this is really about: they were
    // reachable by right-click alone, and a menu that lists a key for six of
    // its ten entries reads as if the rest cannot be typed at all.
    act(() => useEditorStore.getState().addPrimitive('box'));
    openMenu();
    render(<CursorMenu />);

    for (const item of screen.getAllByRole('menuitem')) {
      expect(hintFor(item.textContent ?? '')).toMatch(/\([A-Z+]+\)$/);
    }
  });

  it('disables the entries that need a selection while there is none', () => {
    openMenu();
    render(<CursorMenu />);

    for (const name of NEEDS_SELECTION) {
      expect(screen.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
    }
    expect(hintFor('SELECTION TO CURSOR')).toContain('Nothing selected to move onto the cursor');

    // The entries that move nothing but the cursor stay available.
    const origin = screen.getByRole('menuitem', { name: 'CURSOR TO WORLD ORIGIN' });
    expect(origin).not.toHaveAttribute('aria-disabled');
  });

  it('enables them once something is selected', () => {
    act(() => useEditorStore.getState().addPrimitive('box'));

    openMenu();
    render(<CursorMenu />);

    for (const name of NEEDS_SELECTION) {
      expect(screen.getByRole('menuitem', { name })).not.toHaveAttribute('aria-disabled');
    }
  });

  it('keeps the origin entry in edit mode, where the vertices have none', () => {
    const store = useEditorStore.getState();
    act(() => {
      store.addPrimitive('box');
      // Entering edit mode drops the vertex selection, so there is geometry to
      // take an origin from and none to take a median from.
      store.setMode('edit');
    });

    openMenu();
    render(<CursorMenu />);

    expect(screen.getByRole('menuitem', { name: 'CURSOR TO SELECTION' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      screen.getByRole('menuitem', { name: 'CURSOR TO SELECTION ORIGIN' }),
    ).not.toHaveAttribute('aria-disabled');
  });

  it('refuses to move a locked object and says how to unlock it', () => {
    const store = useEditorStore.getState();
    act(() => {
      store.addPrimitive('box');
      store.toggleObjectLock(useEditorStore.getState().objects[0].id);
    });

    openMenu();
    render(<CursorMenu />);

    expect(screen.getByRole('menuitem', { name: 'SELECTION TO CURSOR' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(hintFor('ORIGIN OF SELECTED TO CURSOR')).toContain('Unlock');
    // Sending the cursor to it moves nothing, so the lock has no say in it.
    expect(screen.getByRole('menuitem', { name: 'CURSOR TO SELECTION' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('refuses to move the origin of a linked copy', () => {
    const store = useEditorStore.getState();
    act(() => {
      store.addPrimitive('box');
      store.duplicateSelected(true);
    });

    openMenu();
    render(<CursorMenu />);

    expect(hintFor('ORIGIN OF SELECTED TO CURSOR')).toContain('single-user');
    expect(screen.getByRole('menuitem', { name: 'ORIGIN OF SELECTED TO CURSOR' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // The geometry itself still moves: it is only the origin the shared mesh
    // holds back.
    expect(screen.getByRole('menuitem', { name: 'SELECTION TO CURSOR' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });
});
