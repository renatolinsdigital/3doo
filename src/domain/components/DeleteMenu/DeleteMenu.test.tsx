import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { activeObject, useEditorStore } from '@store/index';

import { DeleteMenu } from './DeleteMenu';

const store = () => useEditorStore.getState();

function mesh() {
  const object = activeObject(store());
  if (!object) throw new Error('No active object');
  return object.mesh;
}

const ENTRIES = [
  'DELETE VERTICES',
  'DELETE EDGES',
  'DELETE FACES',
  'DISSOLVE VERTICES',
  'DISSOLVE EDGES',
  'DISSOLVE FACES',
];

/** A primitive in edit mode, with nothing selected yet. */
function editing(kind: 'cube' | 'plane') {
  act(() => {
    store().addPrimitive(kind);
    store().setMode('edit');
  });
}

/** Selects the faces `pick` names, the way a click in face select would. */
function selectFaces(pick: (normal: { x: number; y: number; z: number }) => boolean) {
  act(() => {
    mesh().deselectAll();
    for (const face of mesh().faces.values()) face.selected = pick(face.normal);
    mesh().flushSelection('face');
    store().touchMesh();
  });
}

function openMenu() {
  act(() => store().openDeleteMenu({ x: 10, y: 10 }));
}

function entry(name: string) {
  return screen.getByRole('menuitem', { name });
}

/** The hint an entry raises, which the tooltip host reads out of the store. */
function hintFor(name: string): string {
  fireEvent.focus(entry(name));
  return store().hint?.text ?? '';
}

describe('DeleteMenu', () => {
  beforeEach(() => store().resetScene());

  it('lists every delete and dissolve, disabled while nothing is selected', () => {
    editing('cube');
    openMenu();
    render(<DeleteMenu />);

    for (const name of ENTRIES) expect(entry(name)).toHaveAttribute('aria-disabled', 'true');
    expect(hintFor('DELETE EDGES')).toBe('No edges selected to delete');
    expect(hintFor('DISSOLVE FACES')).toBe('No faces selected to dissolve');
  });

  it('enables every entry once the whole cube is selected', () => {
    editing('cube');
    act(() => store().exec('selectAll', {}, 'Select all'));
    openMenu();
    render(<DeleteMenu />);

    for (const name of ENTRIES) expect(entry(name)).not.toHaveAttribute('aria-disabled');
  });

  it('holds back a face dissolve until two touching faces are selected', () => {
    editing('cube');
    selectFaces((normal) => normal.y > 0.99);
    openMenu();
    render(<DeleteMenu />);

    // One face has nothing to merge with, and the operator would refuse it.
    expect(entry('DISSOLVE FACES')).toHaveAttribute('aria-disabled', 'true');
    expect(hintFor('DISSOLVE FACES')).toContain('share an edge');
    expect(entry('DELETE FACES')).not.toHaveAttribute('aria-disabled');

    // The top and bottom are two faces, but no edge joins them.
    selectFaces((normal) => Math.abs(normal.y) > 0.99);
    expect(entry('DISSOLVE FACES')).toHaveAttribute('aria-disabled', 'true');

    selectFaces((normal) => normal.y > 0.99 || normal.x > 0.99);
    expect(entry('DISSOLVE FACES')).not.toHaveAttribute('aria-disabled');
  });

  it('holds back an edge dissolve when every selected edge is on an open border', () => {
    editing('plane');
    act(() => store().exec('selectAll', {}, 'Select all'));
    openMenu();
    render(<DeleteMenu />);

    expect(entry('DISSOLVE EDGES')).toHaveAttribute('aria-disabled', 'true');
    expect(hintFor('DISSOLVE EDGES')).toContain('open border');
    expect(entry('DELETE EDGES')).not.toHaveAttribute('aria-disabled');
  });

  it('acts on the type it names, whatever the select mode', async () => {
    editing('cube');
    selectFaces((normal) => normal.y > 0.99);
    act(() => store().setSelectMode('vertex'));
    openMenu();
    render(<DeleteMenu />);

    // X in vertex select would take the four corners and every face on them.
    await userEvent.click(entry('DELETE FACES'));

    expect(mesh().faces.size).toBe(5);
    expect(mesh().verts.size).toBe(8);
    expect(store().historyUndo[0]).toBe('Delete faces');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('dissolves two touching faces into one from its entry', async () => {
    editing('cube');
    selectFaces((normal) => normal.y > 0.99 || normal.x > 0.99);
    openMenu();
    render(<DeleteMenu />);

    await userEvent.click(entry('DISSOLVE FACES'));

    expect(mesh().faces.size).toBe(5);
    expect(store().status).toBe('Dissolved 2 faces');
  });

  it('closes on the way back to object mode, and stays closed on the next visit', () => {
    editing('cube');
    openMenu();
    render(<DeleteMenu />);

    act(() => store().setMode('object'));
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => store().setMode('edit'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
