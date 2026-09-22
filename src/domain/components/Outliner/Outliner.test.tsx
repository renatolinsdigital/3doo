import { act, render, screen, within } from '@testing-library/react';
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

  it('marks the rows that share one mesh, and only those', () => {
    useEditorStore.getState().addPrimitive('box');
    useEditorStore.getState().setActiveObject(useEditorStore.getState().objects[0].id);
    useEditorStore.getState().duplicateSelected(true);
    useEditorStore.getState().addPrimitive('uvSphere');

    render(<Outliner />);

    // Two rows on one mesh, the sphere on its own: a linked duplicate is
    // otherwise indistinguishable from a plain copy.
    expect(screen.getAllByLabelText(/shared with 1 other object/i)).toHaveLength(2);
  });

  it('leaves plain copies unmarked', () => {
    useEditorStore.getState().addPrimitive('box');
    useEditorStore.getState().setActiveObject(useEditorStore.getState().objects[0].id);
    useEditorStore.getState().duplicateSelected(false);

    render(<Outliner />);

    expect(screen.queryByLabelText(/shared with/i)).not.toBeInTheDocument();
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

  describe('row menu', () => {
    const openMenuOn = async (name: string) => {
      const row = screen.getByRole('button', { name }).closest('li') as HTMLElement;
      await userEvent.pointer({ keys: '[MouseRight]', target: row });
    };

    it('opens on right-click, naming the row it was opened on', async () => {
      useEditorStore.getState().addPrimitive('box');
      useEditorStore.getState().addPrimitive('cylinder');
      render(<Outliner />);

      await openMenuOn('CYLINDER');

      const menu = screen.getByRole('menu', { name: 'CYLINDER' });
      // Adding the cylinder selected it, so its row offers the way back out.
      for (const entry of ['DESELECT', 'RENAME', 'APPLY TRANSFORMS', 'DELETE']) {
        expect(within(menu).getByRole('menuitem', { name: entry })).toBeInTheDocument();
      }
    });

    it('selects the object it was opened on', async () => {
      useEditorStore.getState().addPrimitive('box');
      useEditorStore.getState().addPrimitive('cylinder');
      render(<Outliner />);
      const box = useEditorStore.getState().objects[0];

      await openMenuOn('BOX');
      await userEvent.click(screen.getByRole('menuitem', { name: 'SELECT' }));

      expect(useEditorStore.getState().activeObjectId).toBe(box.id);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('offers the way out of the selection instead, once selected', async () => {
      useEditorStore.getState().addPrimitive('box');
      useEditorStore.getState().addPrimitive('cylinder');
      act(() => useEditorStore.getState().selectAllObjects());
      render(<Outliner />);
      const [box, cylinder] = useEditorStore.getState().objects;

      await openMenuOn('BOX');
      await userEvent.click(screen.getByRole('menuitem', { name: 'DESELECT' }));

      // Only the row the menu was opened on leaves the selection.
      expect(useEditorStore.getState().selectedObjectIds).toEqual([cylinder.id]);
      expect(useEditorStore.getState().activeObjectId).not.toBe(box.id);
    });

    it('starts a rename in place', async () => {
      useEditorStore.getState().addPrimitive('box');
      render(<Outliner />);

      await openMenuOn('BOX');
      await userEvent.click(screen.getByRole('menuitem', { name: 'RENAME' }));

      expect(screen.getByDisplayValue('BOX')).toBeInTheDocument();
    });

    it('deletes only the row it was opened on', async () => {
      useEditorStore.getState().addPrimitive('box');
      useEditorStore.getState().addPrimitive('cylinder');
      act(() => useEditorStore.getState().selectAllObjects());
      render(<Outliner />);

      await openMenuOn('BOX');
      await userEvent.click(screen.getByRole('menuitem', { name: 'DELETE' }));

      // The whole scene was selected: the menu names one row, not the selection.
      expect(useEditorStore.getState().objects.map((object) => object.name)).toEqual(['CYLINDER']);
    });

    it('bakes the transform of the row it was opened on', async () => {
      useEditorStore.getState().addPrimitive('box');
      render(<Outliner />);
      const box = useEditorStore.getState().objects[0];
      act(() =>
        useEditorStore.getState().setObjectTransform(box.id, { scale: { x: 2, y: 2, z: 2 } }),
      );

      await openMenuOn('BOX');
      await userEvent.click(screen.getByRole('menuitem', { name: 'APPLY TRANSFORMS' }));

      expect(useEditorStore.getState().objects[0].transform.scale).toEqual({ x: 1, y: 1, z: 1 });
    });

    it('will not bake a locked object', async () => {
      useEditorStore.getState().addPrimitive('box');
      render(<Outliner />);
      const box = useEditorStore.getState().objects[0];
      act(() => useEditorStore.getState().toggleObjectLock(box.id));

      await openMenuOn('BOX');

      expect(screen.getByRole('menuitem', { name: 'APPLY TRANSFORMS' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });
  describe('groups', () => {
    /** Adds a box and a cylinder, puts them in a folder and renders the panel. */
    function grouped() {
      const store = useEditorStore.getState();
      store.addPrimitive('box');
      store.addPrimitive('cylinder');
      store.addPrimitive('uvSphere');
      const [box, cylinder] = useEditorStore.getState().objects;
      act(() => {
        useEditorStore.getState().selectObjects([box.id, cylinder.id]);
        useEditorStore.getState().groupSelected();
      });
      render(<Outliner />);
      return { box, cylinder, group: useEditorStore.getState().groups[0] };
    }

    const openMenuOn = async (name: string) => {
      const row = screen.getByRole('button', { name }).parentElement as HTMLElement;
      await userEvent.pointer({ keys: '[MouseRight]', target: row });
    };

    it('draws the folder with its objects under it, and the rest loose', () => {
      grouped();

      expect(screen.getByRole('button', { name: 'GROUP' })).toBeInTheDocument();
      for (const name of ['BOX', 'CYLINDER', 'UV SPHERE']) {
        expect(screen.getByRole('button', { name })).toBeInTheDocument();
      }
    });

    it('folds the rows away and brings them back', async () => {
      grouped();

      await userEvent.click(screen.getByRole('button', { name: 'Collapse GROUP' }));

      expect(screen.queryByRole('button', { name: 'BOX' })).not.toBeInTheDocument();
      // The loose object is not in the folder, so it stays on screen.
      expect(screen.getByRole('button', { name: 'UV SPHERE' })).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Expand GROUP' }));
      expect(screen.getByRole('button', { name: 'BOX' })).toBeInTheDocument();
    });

    it('selects what is in the folder when its title is clicked', async () => {
      const { box, cylinder } = grouped();

      await userEvent.click(screen.getByRole('button', { name: 'GROUP' }));

      expect(useEditorStore.getState().selectedObjectIds).toEqual([box.id, cylinder.id]);
    });

    it('hides and shows the whole folder from its row', async () => {
      grouped();

      await userEvent.click(screen.getByRole('button', { name: 'Hide GROUP' }));

      const visible = useEditorStore.getState().objects.map((object) => object.visible);
      expect(visible).toEqual([false, false, true]);
      expect(screen.getByRole('button', { name: 'Show GROUP' })).toBeInTheDocument();
    });

    it('locks and unlocks the whole folder from its row', async () => {
      grouped();

      await userEvent.click(screen.getByRole('button', { name: 'Lock GROUP' }));

      expect(useEditorStore.getState().objects.map((object) => object.locked)).toEqual([
        true,
        true,
        false,
      ]);
      expect(screen.getByRole('button', { name: 'Unlock GROUP' })).toBeInTheDocument();
    });

    it('opens the folder menu on right-click', async () => {
      grouped();

      await openMenuOn('GROUP');

      const menu = screen.getByRole('menu', { name: 'GROUP' });
      for (const entry of ['RENAME', 'SELECT ALL', 'JOIN', 'UNGROUP', 'DELETE']) {
        expect(within(menu).getByRole('menuitem', { name: entry })).toBeInTheDocument();
      }
    });

    it('renames the folder in place', async () => {
      grouped();

      await userEvent.dblClick(screen.getByRole('button', { name: 'GROUP' }));
      const input = screen.getByDisplayValue('GROUP');
      await userEvent.clear(input);
      await userEvent.type(input, 'CHASSIS{Enter}');

      expect(useEditorStore.getState().groups[0].name).toBe('CHASSIS');
    });

    it('deletes the folder and its objects, leaving the loose one', async () => {
      grouped();

      await openMenuOn('GROUP');
      await userEvent.click(screen.getByRole('menuitem', { name: 'DELETE' }));

      expect(useEditorStore.getState().objects.map((object) => object.name)).toEqual(['UV SPHERE']);
      expect(useEditorStore.getState().groups).toEqual([]);
    });

    it('ungroups without touching the objects', async () => {
      grouped();

      await openMenuOn('GROUP');
      await userEvent.click(screen.getByRole('menuitem', { name: 'UNGROUP' }));

      expect(useEditorStore.getState().objects).toHaveLength(3);
      expect(screen.queryByRole('button', { name: 'GROUP' })).not.toBeInTheDocument();
    });

    it('joins the folder into one object', async () => {
      grouped();

      await openMenuOn('GROUP');
      await userEvent.click(screen.getByRole('menuitem', { name: 'JOIN' }));

      expect(useEditorStore.getState().objects).toHaveLength(2);
    });

    it('will not join a folder that is locked', async () => {
      const { group } = grouped();
      act(() => useEditorStore.getState().toggleGroupLock(group.id));

      await openMenuOn('GROUP');

      expect(screen.getByRole('menuitem', { name: 'JOIN' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });
});
