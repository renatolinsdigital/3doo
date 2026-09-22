import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
    useEditorStore.getState().addPrimitive('cube');
    useEditorStore.getState().addPrimitive('uvSphere');

    render(<Outliner />);

    expect(screen.getByRole('button', { name: 'CUBE' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'UV SPHERE' })).toBeInTheDocument();
  });

  it('marks the rows that share one mesh, and only those', () => {
    useEditorStore.getState().addPrimitive('cube');
    useEditorStore.getState().setActiveObject(useEditorStore.getState().objects[0].id);
    useEditorStore.getState().duplicateSelected(true);
    useEditorStore.getState().addPrimitive('uvSphere');

    render(<Outliner />);

    // Two rows on one mesh, the sphere on its own: a linked duplicate is
    // otherwise indistinguishable from a plain copy.
    expect(screen.getAllByLabelText(/shared with 1 other object/i)).toHaveLength(2);
  });

  it('leaves plain copies unmarked', () => {
    useEditorStore.getState().addPrimitive('cube');
    useEditorStore.getState().setActiveObject(useEditorStore.getState().objects[0].id);
    useEditorStore.getState().duplicateSelected(false);

    render(<Outliner />);

    expect(screen.queryByLabelText(/shared with/i)).not.toBeInTheDocument();
  });

  it('makes a clicked object active', async () => {
    useEditorStore.getState().addPrimitive('cube');
    useEditorStore.getState().addPrimitive('cylinder');
    render(<Outliner />);

    await userEvent.click(screen.getByRole('button', { name: 'CUBE' }));

    const state = useEditorStore.getState();
    const box = state.objects.find((object) => object.name === 'CUBE');
    expect(state.activeObjectId).toBe(box?.id);
  });

  describe('building a selection from the rows', () => {
    /** Four loose rows, in the order the outliner reads them down the panel. */
    function rows() {
      const store = useEditorStore.getState();
      for (const kind of ['cube', 'cylinder', 'uvSphere', 'cone'] as const)
        store.addPrimitive(kind);
      render(<Outliner />);
      return useEditorStore.getState().objects;
    }

    const shiftClick = (name: string) =>
      fireEvent.click(screen.getByRole('button', { name }), { shiftKey: true });

    const ctrlClick = (name: string) =>
      fireEvent.click(screen.getByRole('button', { name }), { ctrlKey: true });

    it('takes in every row between the active one and the one clicked', async () => {
      const [box, cylinder, sphere] = rows();

      await userEvent.click(screen.getByRole('button', { name: 'CUBE' }));
      shiftClick('UV SPHERE');

      const state = useEditorStore.getState();
      expect(state.selectedObjectIds).toEqual([box.id, cylinder.id, sphere.id]);
      expect(state.activeObjectId).toBe(sphere.id);
    });

    it('runs the same way upwards, and leaves the row clicked active', async () => {
      const [box, cylinder, sphere] = rows();

      await userEvent.click(screen.getByRole('button', { name: 'UV SPHERE' }));
      shiftClick('CUBE');

      const state = useEditorStore.getState();
      expect([...state.selectedObjectIds].sort()).toEqual([box.id, cylinder.id, sphere.id].sort());
      expect(state.activeObjectId).toBe(box.id);
    });

    it('keeps what was already selected', async () => {
      const [box, cylinder, sphere, cone] = rows();

      await userEvent.click(screen.getByRole('button', { name: 'CUBE' }));
      shiftClick('CYLINDER');
      shiftClick('CONE');

      expect([...useEditorStore.getState().selectedObjectIds].sort()).toEqual(
        [box.id, cylinder.id, sphere.id, cone.id].sort(),
      );
    });

    it('drops the whole run when the row clicked is already selected', async () => {
      const [box] = rows();

      await userEvent.click(screen.getByRole('button', { name: 'CUBE' }));
      shiftClick('CONE');
      // The cylinder is in the selection, so the run back to it comes out
      // again, the cone and the sphere between them included.
      shiftClick('CYLINDER');

      const state = useEditorStore.getState();
      expect(state.selectedObjectIds).toEqual([box.id]);
      expect(state.activeObjectId).toBe(box.id);
    });

    it('adds one row at a time on Ctrl, leaving the rows between alone', async () => {
      const [box, , , cone] = rows();

      await userEvent.click(screen.getByRole('button', { name: 'CUBE' }));
      ctrlClick('CONE');

      const state = useEditorStore.getState();
      expect(state.selectedObjectIds).toEqual([box.id, cone.id]);
      expect(state.activeObjectId).toBe(cone.id);
    });

    it('drops one row at a time on Ctrl', async () => {
      const [, cylinder, sphere] = rows();

      await userEvent.click(screen.getByRole('button', { name: 'CUBE' }));
      shiftClick('UV SPHERE');
      ctrlClick('CUBE');

      const state = useEditorStore.getState();
      expect(state.selectedObjectIds).toEqual([cylinder.id, sphere.id]);
      expect(state.activeObjectId).toBe(sphere.id);
    });

    it('leaves a survivor active when the run drops the active row', async () => {
      const [box] = rows();

      await userEvent.click(screen.getByRole('button', { name: 'CUBE' }));
      shiftClick('CYLINDER');
      shiftClick('CYLINDER');

      const state = useEditorStore.getState();
      expect(state.selectedObjectIds).toEqual([box.id]);
      expect(state.activeObjectId).toBe(box.id);
    });

    it('steps over the rows a folded folder is hiding', async () => {
      const [box, cylinder, sphere, cone] = rows();
      act(() => {
        useEditorStore.getState().selectObjects([cylinder.id, sphere.id]);
        useEditorStore.getState().groupSelected();
      });

      // The folder holds the two middle rows and is folded shut, so the run
      // from the box to the cone has nothing between them to take in.
      await userEvent.click(screen.getByRole('button', { name: 'Collapse GROUP' }));
      await userEvent.click(screen.getByRole('button', { name: 'CUBE' }));
      shiftClick('CONE');

      expect(useEditorStore.getState().selectedObjectIds).toEqual([box.id, cone.id]);
    });
  });

  it('leaves no focus ring on a row picked with the pointer, and keeps it for the keyboard', async () => {
    useEditorStore.getState().addPrimitive('cube');
    render(<Outliner />);
    const row = screen.getByRole('button', { name: 'CUBE' });

    await userEvent.click(row);
    expect(row).not.toHaveFocus();

    // Selecting from the keyboard is the case the ring is there for.
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(row).toHaveFocus();
  });

  it('toggles visibility from the row', async () => {
    useEditorStore.getState().addPrimitive('cube');
    render(<Outliner />);

    await userEvent.click(screen.getByRole('button', { name: 'Hide CUBE' }));

    expect(useEditorStore.getState().objects[0].visible).toBe(false);
  });

  it('toggles the lock from the row', async () => {
    useEditorStore.getState().addPrimitive('cube');
    render(<Outliner />);

    await userEvent.click(screen.getByRole('button', { name: 'Lock CUBE' }));

    expect(useEditorStore.getState().objects[0].locked).toBe(true);
  });

  it('renames on double click', async () => {
    useEditorStore.getState().addPrimitive('cube');
    render(<Outliner />);

    await userEvent.dblClick(screen.getByRole('button', { name: 'CUBE' }));
    const input = screen.getByDisplayValue('CUBE');
    await userEvent.clear(input);
    await userEvent.type(input, 'CHASSIS{Enter}');

    expect(useEditorStore.getState().objects[0].name).toBe('CHASSIS');
  });

  describe('locked-edit feedback', () => {
    afterEach(() => vi.useRealTimers());

    it('trembles the lock icon for 1s once a lockedAttempt reports this object, then settles', () => {
      useEditorStore.getState().addPrimitive('cube');
      const id = useEditorStore.getState().objects[0].id;
      render(<Outliner />);

      expect(screen.getByRole('button', { name: 'Lock CUBE' }).className).not.toMatch(/tremble/);

      vi.useFakeTimers();
      act(() => useEditorStore.setState({ lockedAttempt: { objectId: id, token: 1 } }));
      expect(screen.getByRole('button', { name: 'Lock CUBE' }).className).toMatch(/tremble/);

      // Still shaking most of the way through the 1s run.
      act(() => vi.advanceTimersByTime(900));
      expect(screen.getByRole('button', { name: 'Lock CUBE' }).className).toMatch(/tremble/);

      act(() => vi.advanceTimersByTime(100));
      expect(screen.getByRole('button', { name: 'Lock CUBE' }).className).not.toMatch(/tremble/);
    });

    it('trembles when a locked object is clicked in the outliner', async () => {
      useEditorStore.getState().addPrimitive('cube');
      useEditorStore.getState().toggleObjectLock(useEditorStore.getState().objects[0].id);
      render(<Outliner />);

      await userEvent.click(screen.getByRole('button', { name: 'CUBE' }));

      expect(screen.getByRole('button', { name: 'Unlock CUBE' }).className).toMatch(/tremble/);
      expect(useEditorStore.getState().status).toBe('Object is locked');
    });

    it('leaves an unlocked object alone when it is clicked', async () => {
      useEditorStore.getState().addPrimitive('cube');
      render(<Outliner />);

      await userEvent.click(screen.getByRole('button', { name: 'CUBE' }));

      expect(screen.getByRole('button', { name: 'Lock CUBE' }).className).not.toMatch(/tremble/);
    });

    it('does not tremble for a lockedAttempt on a different object', () => {
      useEditorStore.getState().addPrimitive('cube');
      render(<Outliner />);

      const lockBtn = screen.getByRole('button', { name: 'Lock CUBE' });
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
      useEditorStore.getState().addPrimitive('cube');
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
      useEditorStore.getState().addPrimitive('cube');
      useEditorStore.getState().addPrimitive('cylinder');
      render(<Outliner />);
      const box = useEditorStore.getState().objects[0];

      await openMenuOn('CUBE');
      await userEvent.click(screen.getByRole('menuitem', { name: 'SELECT' }));

      expect(useEditorStore.getState().activeObjectId).toBe(box.id);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('offers the way out of the selection instead, once selected', async () => {
      useEditorStore.getState().addPrimitive('cube');
      useEditorStore.getState().addPrimitive('cylinder');
      act(() => useEditorStore.getState().selectAllObjects());
      render(<Outliner />);
      const [box, cylinder] = useEditorStore.getState().objects;

      await openMenuOn('CUBE');
      await userEvent.click(screen.getByRole('menuitem', { name: 'DESELECT' }));

      // Only the row the menu was opened on leaves the selection.
      expect(useEditorStore.getState().selectedObjectIds).toEqual([cylinder.id]);
      expect(useEditorStore.getState().activeObjectId).not.toBe(box.id);
    });

    it('starts a rename in place', async () => {
      useEditorStore.getState().addPrimitive('cube');
      render(<Outliner />);

      await openMenuOn('CUBE');
      await userEvent.click(screen.getByRole('menuitem', { name: 'RENAME' }));

      expect(screen.getByDisplayValue('CUBE')).toBeInTheDocument();
    });

    it('deletes only the row it was opened on', async () => {
      useEditorStore.getState().addPrimitive('cube');
      useEditorStore.getState().addPrimitive('cylinder');
      act(() => useEditorStore.getState().selectAllObjects());
      render(<Outliner />);

      await openMenuOn('CUBE');
      await userEvent.click(screen.getByRole('menuitem', { name: 'DELETE' }));

      // The whole scene was selected: the menu names one row, not the selection.
      expect(useEditorStore.getState().objects.map((object) => object.name)).toEqual(['CYLINDER']);
    });

    it('bakes the transform of the row it was opened on', async () => {
      useEditorStore.getState().addPrimitive('cube');
      render(<Outliner />);
      const box = useEditorStore.getState().objects[0];
      act(() =>
        useEditorStore.getState().setObjectTransform(box.id, { scale: { x: 2, y: 2, z: 2 } }),
      );

      await openMenuOn('CUBE');
      await userEvent.click(screen.getByRole('menuitem', { name: 'APPLY TRANSFORMS' }));

      expect(useEditorStore.getState().objects[0].transform.scale).toEqual({ x: 1, y: 1, z: 1 });
    });

    it('will not bake a locked object', async () => {
      useEditorStore.getState().addPrimitive('cube');
      render(<Outliner />);
      const box = useEditorStore.getState().objects[0];
      act(() => useEditorStore.getState().toggleObjectLock(box.id));

      await openMenuOn('CUBE');

      expect(screen.getByRole('menuitem', { name: 'APPLY TRANSFORMS' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('puts the selection in a folder', async () => {
      useEditorStore.getState().addPrimitive('cube');
      useEditorStore.getState().addPrimitive('cylinder');
      act(() => useEditorStore.getState().selectAllObjects());
      render(<Outliner />);

      await openMenuOn('CUBE');
      await userEvent.click(screen.getByRole('menuitem', { name: 'GROUP' }));

      const folder = useEditorStore.getState().groups[0];
      expect(useEditorStore.getState().objects.map((object) => object.groupId)).toEqual([
        folder.id,
        folder.id,
      ]);
    });

    it('will not make a folder of one object', async () => {
      useEditorStore.getState().addPrimitive('cube');
      render(<Outliner />);

      await openMenuOn('CUBE');

      expect(screen.getByRole('menuitem', { name: 'GROUP' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });
  describe('groups', () => {
    /** Adds a box and a cylinder, puts them in a folder and renders the panel. */
    function grouped() {
      const store = useEditorStore.getState();
      store.addPrimitive('cube');
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
      for (const name of ['CUBE', 'CYLINDER', 'UV SPHERE']) {
        expect(screen.getByRole('button', { name })).toBeInTheDocument();
      }
    });

    it('folds the rows away and brings them back', async () => {
      grouped();

      await userEvent.click(screen.getByRole('button', { name: 'Collapse GROUP' }));

      expect(screen.queryByRole('button', { name: 'CUBE' })).not.toBeInTheDocument();
      // The loose object is not in the folder, so it stays on screen.
      expect(screen.getByRole('button', { name: 'UV SPHERE' })).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Expand GROUP' }));
      expect(screen.getByRole('button', { name: 'CUBE' })).toBeInTheDocument();
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

    it('takes one object out of the folder from its own menu', async () => {
      const { group } = grouped();

      await openMenuOn('CUBE');
      await userEvent.click(screen.getByRole('menuitem', { name: 'REMOVE FROM GROUP' }));

      expect(useEditorStore.getState().objects[0].groupId).toBeNull();
      expect(useEditorStore.getState().objects[1].groupId).toBe(group.id);
      expect(screen.getByRole('button', { name: 'GROUP' })).toBeInTheDocument();
    });

    it('will not group a selection that is already in a folder', async () => {
      const { box, cylinder } = grouped();
      act(() => useEditorStore.getState().selectObjects([box.id, cylinder.id]));

      await openMenuOn('CUBE');

      expect(screen.getByRole('menuitem', { name: 'GROUP' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('offers nothing to leave on a loose row', async () => {
      grouped();

      await openMenuOn('UV SPHERE');

      expect(screen.queryByRole('menuitem', { name: 'REMOVE FROM GROUP' })).not.toBeInTheDocument();
    });

    const rowOf = (name: string) =>
      screen.getByRole('button', { name }).parentElement as HTMLElement;

    /**
     * Drags one row onto another and lets go of it.
     *
     * The first move clears the distance a press has to travel to count as a
     * drag. `clientY` then picks the half of the row the pointer ends in:
     * every box jsdom measures is empty, so 0 lands above the row and 1 below.
     */
    function dragOnto(from: string, to: HTMLElement, clientY = 0) {
      fireEvent.pointerDown(rowOf(from), { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(to, { clientX: 0, clientY: 20 });
      fireEvent.pointerMove(to, { clientX: 0, clientY });
      fireEvent.pointerUp(to, { clientX: 0, clientY });
    }

    it('puts a loose object in the folder its title is dropped on', () => {
      const { group } = grouped();

      dragOnto('UV SPHERE', rowOf('GROUP'));

      const objects = useEditorStore.getState().objects;
      expect(objects.map((object) => object.name)).toEqual(['CUBE', 'CYLINDER', 'UV SPHERE']);
      expect(objects.every((object) => object.groupId === group.id)).toBe(true);
    });

    it('opens a folded folder that takes a row, so it lands in sight', () => {
      const { group } = grouped();
      act(() => useEditorStore.getState().toggleGroupCollapsed(group.id));

      dragOnto('UV SPHERE', rowOf('GROUP'));

      expect(useEditorStore.getState().groups[0].collapsed).toBe(false);
      expect(screen.getByRole('button', { name: 'UV SPHERE' })).toBeInTheDocument();
    });

    it('sorts the rows by dropping one above another', () => {
      grouped();

      dragOnto('CYLINDER', rowOf('CUBE'));

      expect(useEditorStore.getState().objects.map((object) => object.name)).toEqual([
        'CYLINDER',
        'CUBE',
        'UV SPHERE',
      ]);
    });

    it('takes an object out of its folder when it lands beside a loose row', () => {
      const { group } = grouped();

      dragOnto('CUBE', rowOf('UV SPHERE'), 1);

      const objects = useEditorStore.getState().objects;
      expect(objects.map((object) => object.name)).toEqual(['CYLINDER', 'UV SPHERE', 'CUBE']);
      expect(objects[2].groupId).toBeNull();
      expect(useEditorStore.getState().groups.map((entry) => entry.id)).toEqual([group.id]);
    });

    it('leaves the row where it was when it is let go over nothing', () => {
      grouped();

      fireEvent.pointerDown(rowOf('CUBE'), { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(document.body, { clientX: 300, clientY: 300 });
      fireEvent.pointerUp(document.body, { clientX: 300, clientY: 300 });

      expect(useEditorStore.getState().objects.map((object) => object.name)).toEqual([
        'CUBE',
        'CYLINDER',
        'UV SPHERE',
      ]);
    });

    it('leaves the list alone when a press never travels', () => {
      grouped();

      fireEvent.pointerDown(rowOf('CYLINDER'), { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerUp(rowOf('CUBE'), { clientX: 0, clientY: 0 });

      expect(useEditorStore.getState().objects.map((object) => object.name)).toEqual([
        'CUBE',
        'CYLINDER',
        'UV SPHERE',
      ]);
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
