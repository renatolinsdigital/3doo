import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Edge } from '@kernel/index';
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
  store.addPrimitive('cube');
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
    store.addPrimitive('cube');
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

describe('PropertiesPanel typed rotation pivot', () => {
  const ROWS = { LOCATION: 0, ROTATION: 1, SCALE: 2 };
  const field = (row: keyof typeof ROWS, axis: string) =>
    screen.getAllByLabelText(axis)[ROWS[row]] as HTMLInputElement;

  const boxFiveMetresOut = () => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addPrimitive('cube');
    const id = useEditorStore.getState().objects[0].id;
    store.setObjectTransforms([{ id, transform: { position: { x: -5, y: 0, z: 0 } } }]);
    store.setCursor({ x: 0, y: 0, z: 0 });
    return id;
  };

  it('swings the object round the 3D cursor when that is the pivot', async () => {
    boxFiveMetresOut();
    useEditorStore.getState().setPivot('cursor');

    render(<PropertiesPanel />);
    const y = field('ROTATION', 'Y');
    await userEvent.clear(y);
    await userEvent.type(y, '45{Enter}');

    // The handles stand on the cursor, so the turn has to happen there: the box
    // used to keep its position and spin five metres away from the gizmo.
    const { position, rotation } = useEditorStore.getState().objects[0].transform;
    expect(rotation.y).toBeCloseTo(Math.PI / 4);
    expect(position.x).toBeCloseTo(-Math.SQRT1_2 * 5);
    expect(position.z).toBeCloseTo(Math.SQRT1_2 * 5);
  });

  it('turns the object where it stands on the median pivot', async () => {
    boxFiveMetresOut();
    useEditorStore.getState().setPivot('median');

    render(<PropertiesPanel />);
    const y = field('ROTATION', 'Y');
    await userEvent.clear(y);
    await userEvent.type(y, '45{Enter}');

    const { position, rotation } = useEditorStore.getState().objects[0].transform;
    expect(rotation.y).toBeCloseTo(Math.PI / 4);
    expect(position).toEqual({ x: -5, y: 0, z: 0 });
  });

  it('reads the next turn off the one already typed rather than compounding it', async () => {
    boxFiveMetresOut();
    useEditorStore.getState().setPivot('cursor');

    render(<PropertiesPanel />);
    const y = field('ROTATION', 'Y');
    await userEvent.clear(y);
    await userEvent.type(y, '45{Enter}');
    await userEvent.clear(y);
    await userEvent.type(y, '90{Enter}');

    // Two entries, one quarter turn: the field names where to end up, so the
    // origin sits a quarter turn from where it started, not three eighths.
    const { position, rotation } = useEditorStore.getState().objects[0].transform;
    expect(rotation.y).toBeCloseTo(Math.PI / 2);
    expect(position.x).toBeCloseTo(0);
    expect(position.z).toBeCloseTo(5);
  });
});

describe('PropertiesPanel selected edge(s)', () => {
  /** A box in edit mode, with nothing picked out of it yet. */
  function editableBox() {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addPrimitive('cube');
    store.setMode('edit');
    store.setSelectMode('edge');
    useEditorStore.getState().objects[0].mesh.deselectAll();
    store.touchMesh();
  }

  /** Selects `count` edges that share no vertex, the way separate clicks would. */
  function selectApart(count: number) {
    const mesh = useEditorStore.getState().objects[0].mesh;
    mesh.deselectAll();

    const ends = new Set<number>();
    for (const edge of mesh.edges.values()) {
      if (ends.size >= count * 2) break;
      if (ends.has(edge.v0.id) || ends.has(edge.v1.id)) continue;
      edge.selected = true;
      ends.add(edge.v0.id);
      ends.add(edge.v1.id);
    }

    mesh.flushSelection('edge');
    useEditorStore.getState().touchMesh();
  }

  /** Selects two edges that meet, which is what the field refuses. */
  function selectTouching() {
    const mesh = useEditorStore.getState().objects[0].mesh;
    mesh.deselectAll();

    const [first] = [...mesh.edges.values()];
    const touching = [...mesh.edges.values()].find(
      (edge) => edge !== first && [first.v0.id, first.v1.id].includes(edge.v0.id),
    );
    first.selected = true;
    if (touching) touching.selected = true;

    mesh.flushSelection('edge');
    useEditorStore.getState().touchMesh();
  }

  const lengthField = () => screen.getByLabelText('LENGTH') as HTMLInputElement;
  /** The label cell beside the field, which is also its scrub handle. */
  const lengthHandle = () => screen.getByText('LENGTH');

  beforeEach(editableBox);

  it('stays out of the way in object mode', () => {
    useEditorStore.getState().setMode('object');

    render(<PropertiesPanel />);

    expect(screen.queryByLabelText('LENGTH')).not.toBeInTheDocument();
  });

  it('is disabled with nothing selected', () => {
    render(<PropertiesPanel />);

    expect(lengthField()).toBeDisabled();
  });

  it('is disabled for edges that meet at a vertex', () => {
    selectTouching();

    render(<PropertiesPanel />);

    expect(lengthField()).toBeDisabled();
  });

  it('shows the length of what is selected', () => {
    selectApart(2);

    render(<PropertiesPanel />);

    // A fresh box is one metre across, so each of its edges measures one.
    expect(lengthField().value).toBe('1');
  });

  it('shows that length in world metres, with the object scale applied', () => {
    const id = useEditorStore.getState().objects[0].id;
    useEditorStore.getState().setObjectTransform(id, { scale: { x: 3, y: 3, z: 3 } });
    selectApart(1);

    render(<PropertiesPanel />);

    expect(lengthField().value).toBe('3');
  });

  /** How long `edge` measures in the mesh itself. */
  const measure = (edge: Edge) =>
    Math.hypot(
      edge.v1.co.x - edge.v0.co.x,
      edge.v1.co.y - edge.v0.co.y,
      edge.v1.co.z - edge.v0.co.z,
    );

  const selectedEdges = () =>
    [...useEditorStore.getState().objects[0].mesh.edges.values()].filter((edge) => edge.selected);

  it('sets every selected edge to the length typed into it, with no button to press', async () => {
    selectApart(2);

    render(<PropertiesPanel />);
    await userEvent.clear(lengthField());
    await userEvent.type(lengthField(), '0.5{Enter}');

    expect(selectedEdges()).toHaveLength(2);
    for (const edge of selectedEdges()) expect(measure(edge)).toBeCloseTo(0.5);
  });

  it('sets it on the way out of the field too, without an Enter', async () => {
    selectApart(1);

    render(<PropertiesPanel />);
    await userEvent.clear(lengthField());
    await userEvent.type(lengthField(), '0.25');
    await userEvent.tab();

    for (const edge of selectedEdges()) expect(measure(edge)).toBeCloseTo(0.25);
  });

  it('leaves the edge alone when the field is emptied and left', async () => {
    selectApart(1);

    render(<PropertiesPanel />);
    await userEvent.clear(lengthField());
    await userEvent.tab();

    // An empty field is not a length of zero, and reading it as one would
    // collapse the edge onto a point.
    for (const edge of selectedEdges()) expect(measure(edge)).toBeCloseTo(1);
    expect(lengthField().value).toBe('1');
  });

  /**
   * Drags `handle` from x=0 through each x in `travel`, as a scrub does.
   *
   * Wrapped as one act: the store update each move causes reaches the panel
   * through a subscription rather than through React's own event path, so
   * without it every tick warns about an update outside act.
   */
  function scrub(handle: HTMLElement, travel: readonly number[]) {
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
      for (const clientX of travel) fireEvent.pointerMove(handle, { pointerId: 1, clientX });
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: travel[travel.length - 1] ?? 0 });
    });
  }

  it('takes a whole scrub of the label back in one undo step', () => {
    selectApart(1);
    const steps = useEditorStore.getState().historyUndo.length;

    render(<PropertiesPanel />);
    scrub(lengthHandle(), [20, 40, 60]);

    // Three pointer moves, one step: a snapshot per tick would bury the rest of
    // the timeline under a single drag.
    expect(useEditorStore.getState().historyUndo).toHaveLength(steps + 1);
    expect(useEditorStore.getState().historyUndo[0]).toBe('Set edge length');
    for (const edge of selectedEdges()) expect(measure(edge)).toBeGreaterThan(1);

    useEditorStore.getState().undo();
    for (const edge of selectedEdges()) expect(measure(edge)).toBeCloseTo(1);
  });

  it('leaves no step behind for a press of the label that never travelled', () => {
    selectApart(1);
    const steps = useEditorStore.getState().historyUndo.length;

    render(<PropertiesPanel />);
    scrub(lengthHandle(), []);

    expect(useEditorStore.getState().historyUndo).toHaveLength(steps);
  });
});
