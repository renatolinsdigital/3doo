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
