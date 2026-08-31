import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { PropertiesPanel } from './PropertiesPanel';

/**
 * A box with a second slot, so a delete has something to renumber.
 *
 * Both are given names of their own: the default ones run off a counter that
 * outlives `resetScene`, so "Material 1" belongs to whichever test ran first.
 */
function twoSlotBox() {
  const store = useEditorStore.getState();
  store.resetScene();
  store.addPrimitive('box');
  store.addMaterial();
  store.updateMaterial(0, { name: 'BODY' });
  store.updateMaterial(1, { name: 'TRIM' });
}

const slot = (name: string) => screen.getByRole('button', { name });

const openMenuOn = async (name: string) => {
  const row = slot(name).closest('li') as HTMLElement;
  await userEvent.pointer({ keys: '[MouseRight]', target: row });
};

describe('PropertiesPanel material slots', () => {
  beforeEach(twoSlotBox);

  it('renames a slot on double click', async () => {
    render(<PropertiesPanel />);

    await userEvent.dblClick(slot('BODY'));
    const input = screen.getByDisplayValue('BODY');
    await userEvent.clear(input);
    await userEvent.type(input, 'CHROME{Enter}');

    expect(useEditorStore.getState().objects[0].materials[0].name).toBe('CHROME');
  });

  it('keeps the old name when the rename is left empty', async () => {
    render(<PropertiesPanel />);

    await userEvent.dblClick(slot('BODY'));
    const input = screen.getByDisplayValue('BODY');
    await userEvent.clear(input);
    await userEvent.type(input, '{Enter}');

    expect(useEditorStore.getState().objects[0].materials[0].name).toBe('BODY');
  });

  it('abandons the rename on Escape', async () => {
    render(<PropertiesPanel />);

    await userEvent.dblClick(slot('BODY'));
    const input = screen.getByDisplayValue('BODY');
    await userEvent.clear(input);
    await userEvent.type(input, 'CHROME{Escape}');

    expect(useEditorStore.getState().objects[0].materials[0].name).toBe('BODY');
  });

  it('opens a menu on right-click, naming the slot it was opened on', async () => {
    render(<PropertiesPanel />);

    await openMenuOn('TRIM');

    const menu = screen.getByRole('menu', { name: 'TRIM' });
    for (const entry of ['RENAME', 'DELETE']) {
      expect(within(menu).getByRole('menuitem', { name: entry })).toBeInTheDocument();
    }
  });

  it('starts a rename in place from the menu', async () => {
    render(<PropertiesPanel />);

    await openMenuOn('BODY');
    await userEvent.click(screen.getByRole('menuitem', { name: 'RENAME' }));

    expect(screen.getByDisplayValue('BODY')).toBeInTheDocument();
  });

  it('deletes only the slot the menu was opened on', async () => {
    render(<PropertiesPanel />);

    await openMenuOn('BODY');
    await userEvent.click(screen.getByRole('menuitem', { name: 'DELETE' }));

    expect(useEditorStore.getState().objects[0].materials.map((m) => m.name)).toEqual(['TRIM']);
  });

  it('swallows the browser menu when it opens its own', async () => {
    render(<PropertiesPanel />);

    const row = slot('BODY').closest('li') as HTMLElement;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    row.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});

describe('PropertiesPanel transform precision', () => {
  beforeEach(() => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addPrimitive('box');
  });

  // LOCATION, ROTATION and SCALE each label their axes X, Y and Z, and the
  // legend above them is a caption rather than a fieldset, so the row is picked
  // out by the order the panel stacks them in.
  const ROWS = { LOCATION: 0, ROTATION: 1, SCALE: 2 };
  const field = (row: keyof typeof ROWS, axis: string) =>
    screen.getAllByLabelText(axis)[ROWS[row]] as HTMLInputElement;

  it('shows a dragged position to six places, not to sixteen', () => {
    const store = useEditorStore.getState();
    const id = useEditorStore.getState().objects[0].id;
    // What a gizmo drag actually lands on.
    store.setObjectTransforms([
      { id, transform: { position: { x: -1.02940823421855, y: 1.245599230245133, z: 3.05e-16 } } },
    ]);

    render(<PropertiesPanel />);

    expect(field('LOCATION', 'X').value).toBe('-1.029408');
    expect(field('LOCATION', 'Y').value).toBe('1.245599');
    expect(field('LOCATION', 'Z').value).toBe('0');
    // Rounded for reading only: the store still holds what the drag produced.
    expect(useEditorStore.getState().objects[0].transform.position.x).toBe(-1.02940823421855);
  });

  it('leaves the axes it was not asked about at full precision', async () => {
    const store = useEditorStore.getState();
    const id = useEditorStore.getState().objects[0].id;
    const y = 0.5347744685783609;
    store.setObjectTransforms([{ id, transform: { rotation: { x: 0, y, z: 0 } } }]);

    render(<PropertiesPanel />);
    const x = field('ROTATION', 'X');
    await userEvent.clear(x);
    await userEvent.type(x, '45{Enter}');

    // Typing into one axis used to write the other two back at the two decimal
    // places they were displayed with, quietly coarsening a turn nobody touched.
    expect(useEditorStore.getState().objects[0].transform.rotation.y).toBe(y);
  });
});
