import { describe, expect, it } from 'vitest';

import type { BMesh, Edge, SelectMode } from '@kernel/index';
import { createGrid } from '@kernel/primitives';

import {
  type SelectModifiers,
  SELECT_ADD_CURSOR,
  SELECT_ADD_LOOP_CURSOR,
  SELECT_LOOP_CURSOR,
  SELECT_SUBTRACT_CURSOR,
  SELECT_SUBTRACT_LOOP_CURSOR,
  clickElement,
  clickIntent,
  selectCursor,
  selectIntent,
} from './Viewport';

/** A pointer event's modifiers, Alt included: the point of some of these is that it is ignored. */
const keys = (held: Partial<SelectModifiers & { altKey: boolean }>): SelectModifiers => ({
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...held,
});

/** The three marks, as the SVG spells them: the sign's two strokes and the loop's ring. */
const BAR = "d='M19 23h8'";
const UPRIGHT = "d='M23 19v8'";
const RING = '<ellipse';

/** Where the ring is centred, and where the sign's bar runs, read off the drawing itself. */
const ringY = (svg: string) => Number(svg.split("cy='")[1].split("'")[0]);
const ringRadius = (svg: string) => Number(svg.split("ry='")[1].split("'")[0]);
const barY = (svg: string) => Number(svg.split('h8')[0].split(' ').pop());

/** The SVG inside a cursor value, decoded back out of its data URI. */
const svgOf = (cursor: string) =>
  decodeURIComponent(cursor.slice(cursor.indexOf(',') + 1).split('")')[0]);

describe('what the keys held over a pick ask for', () => {
  it('replaces on a bare click', () => {
    expect(selectIntent(keys({}))).toBe('replace');
  });

  it('adds on Shift and takes away on Shift+Ctrl', () => {
    expect(selectIntent(keys({ shiftKey: true }))).toBe('add');
    expect(selectIntent(keys({ shiftKey: true, ctrlKey: true }))).toBe('subtract');
  });

  it('takes Command for Ctrl, which is the only one of the two a Mac spares', () => {
    expect(selectIntent(keys({ shiftKey: true, metaKey: true }))).toBe('subtract');
  });

  it('says nothing about a pick that is not asking to build a selection', () => {
    // Ctrl without Shift is not the subtract gesture: on its own it replaces,
    // the same as a bare click, rather than half-reading the pair.
    expect(selectIntent(keys({ ctrlKey: true }))).toBe('replace');
    expect(selectIntent(keys({ metaKey: true }))).toBe('replace');
  });

  it('leaves Alt out of it, so a loop is added or removed by the same rule', () => {
    expect(selectIntent(keys({ altKey: true }))).toBe('replace');
    expect(selectIntent(keys({ shiftKey: true, altKey: true }))).toBe('add');
    expect(selectIntent(keys({ shiftKey: true, ctrlKey: true, altKey: true }))).toBe('subtract');
  });

  it('leaves which way a Shift+click goes to what it lands on', () => {
    // Shift names the gesture rather than its direction: the one key both
    // builds a selection and trims it.
    const intent = selectIntent(keys({ shiftKey: true }));
    expect(clickIntent(intent, false)).toBe('add');
    expect(clickIntent(intent, true)).toBe('subtract');
  });
});

describe('which way a click goes once it is known what it landed on', () => {
  it('takes in what is out and drops what is already in, under Shift', () => {
    expect(clickIntent('add', false)).toBe('add');
    expect(clickIntent('add', true)).toBe('subtract');
  });

  it('leaves a bare click and Shift+Ctrl alone, whatever is under the pointer', () => {
    for (const selected of [false, true]) {
      expect(clickIntent('replace', selected)).toBe('replace');
      expect(clickIntent('subtract', selected)).toBe('subtract');
    }
  });
});

/** A 4 by 4 sheet of quads: the smallest one with a loop running clean across it. */
const sheet = () => createGrid(1, 4);

/** The sheet's vertex at column `x` and row `z`, each counted 0 to 4. */
const vertAt = (mesh: BMesh, x: number, z: number) => [...mesh.verts.values()][z * 5 + x];

/** The sheet's edge from one vertex to another, which has to be there. */
function edgeAt(mesh: BMesh, from: [number, number], to: [number, number]): Edge {
  const edge = mesh.findEdge(vertAt(mesh, ...from), vertAt(mesh, ...to));
  if (!edge) throw new Error(`no edge from ${from} to ${to}`);
  return edge;
}

/** An element in the middle of the sheet, well clear of its border, for each select mode. */
function middleOf(mesh: BMesh, mode: SelectMode): number {
  if (mode === 'vertex') return vertAt(mesh, 2, 2).id;
  if (mode === 'edge') return edgeAt(mesh, [2, 1], [2, 2]).id;
  return [...mesh.faces.values()][5].id;
}

function isSelected(mesh: BMesh, mode: SelectMode, id: number): boolean {
  if (mode === 'vertex') return mesh.verts.get(id)?.selected ?? false;
  if (mode === 'edge') return mesh.edges.get(id)?.selected ?? false;
  return mesh.faces.get(id)?.selected ?? false;
}

/** A Shift+click on one element, with or without Alt naming its loop. */
const shiftClick = (mesh: BMesh, mode: SelectMode, id: number, loop = false) =>
  clickElement(mesh, mode, { kind: mode, elementId: id }, 'add', loop);

describe('a Shift+click on the mesh being edited', () => {
  const modes: SelectMode[] = ['vertex', 'edge', 'face'];

  it.each(modes)('picks a %s up on the first click and puts it down on the second', (mode) => {
    const mesh = sheet();
    const id = middleOf(mesh, mode);

    shiftClick(mesh, mode, id);
    expect(isSelected(mesh, mode, id)).toBe(true);
    shiftClick(mesh, mode, id);
    expect(isSelected(mesh, mode, id)).toBe(false);
  });

  it('drops only the vertex clicked and keeps the rest of the selection', () => {
    const mesh = sheet();
    const kept = vertAt(mesh, 1, 1);
    const dropped = vertAt(mesh, 3, 3);
    shiftClick(mesh, 'vertex', kept.id);
    shiftClick(mesh, 'vertex', dropped.id);

    shiftClick(mesh, 'vertex', dropped.id);

    expect(kept.selected).toBe(true);
    expect(dropped.selected).toBe(false);
  });

  it('drops a face without taking the corners it shares with one still picked', () => {
    const mesh = sheet();
    const [first, second] = [...mesh.faces.values()];
    shiftClick(mesh, 'face', first.id);
    shiftClick(mesh, 'face', second.id);

    shiftClick(mesh, 'face', first.id);

    // The two share a side. Flushing from faces is what keeps that side's
    // corners picked for the face that stays, and lets the other two go.
    expect(first.selected).toBe(false);
    expect(second.selected).toBe(true);
    expect(mesh.faceVerts(second).every((vert) => vert.selected)).toBe(true);
    expect(mesh.selectedVerts()).toHaveLength(4);
  });

  it('adds a whole loop, and takes it back out from any edge along it', () => {
    const mesh = sheet();
    const first = edgeAt(mesh, [2, 1], [2, 2]);
    const further = edgeAt(mesh, [2, 3], [2, 4]);

    shiftClick(mesh, 'edge', first.id, true);
    // Column 2 runs border to border, four edges long.
    expect(mesh.selectedEdges()).toHaveLength(4);
    expect(further.selected).toBe(true);

    shiftClick(mesh, 'edge', further.id, true);
    expect(mesh.selectedEdges()).toHaveLength(0);
  });

  it('adds a loop through an edge left out of it, rather than dropping the edge', () => {
    const mesh = sheet();
    const picked = edgeAt(mesh, [2, 1], [2, 2]);
    const across = edgeAt(mesh, [1, 2], [2, 2]);
    shiftClick(mesh, 'edge', picked.id);

    shiftClick(mesh, 'edge', across.id, true);

    // The edge under the pointer was out, so its loop goes in and the edge
    // picked before stays where it was.
    expect(picked.selected).toBe(true);
    expect(across.selected).toBe(true);
    expect(mesh.selectedEdges()).toHaveLength(5);
  });
});

describe('the marks the pointer wears', () => {
  const ALL = [
    SELECT_ADD_CURSOR,
    SELECT_SUBTRACT_CURSOR,
    SELECT_LOOP_CURSOR,
    SELECT_ADD_LOOP_CURSOR,
    SELECT_SUBTRACT_LOOP_CURSOR,
  ];

  it('wears a minus over something already selected and a plus over anything else', () => {
    // The sign is the click's own answer, read before the click is made.
    const shift = selectIntent(keys({ shiftKey: true }));
    expect(selectCursor(clickIntent(shift, true), false)).toBe(SELECT_SUBTRACT_CURSOR);
    expect(selectCursor(clickIntent(shift, false), false)).toBe(SELECT_ADD_CURSOR);
    expect(selectCursor(clickIntent(shift, true), true)).toBe(SELECT_SUBTRACT_LOOP_CURSOR);
    expect(selectCursor(clickIntent(shift, false), true)).toBe(SELECT_ADD_LOOP_CURSOR);
  });

  it('wears no sign for a click that replaces, and the ring alone for a loop', () => {
    expect(selectCursor('replace', false)).toBe('');
    expect(selectCursor('replace', true)).toBe(SELECT_LOOP_CURSOR);
  });

  it('hangs a plus off the arrow for adding and a minus for taking away', () => {
    const plus = svgOf(SELECT_ADD_CURSOR);
    const minus = svgOf(SELECT_SUBTRACT_CURSOR);

    // The bar is the half they share; only the plus carries the upright.
    expect(plus).toContain(BAR);
    expect(minus).toContain(BAR);
    expect(plus).toContain(UPRIGHT);
    expect(minus).not.toContain(UPRIGHT);
  });

  it('adds the ring only where Alt would take a whole loop', () => {
    expect(svgOf(SELECT_LOOP_CURSOR)).toContain(RING);
    expect(svgOf(SELECT_ADD_LOOP_CURSOR)).toContain(RING);
    expect(svgOf(SELECT_SUBTRACT_LOOP_CURSOR)).toContain(RING);
    expect(svgOf(SELECT_ADD_CURSOR)).not.toContain(RING);
    expect(svgOf(SELECT_SUBTRACT_CURSOR)).not.toContain(RING);
  });

  it('keeps the ring above the sign, so neither moves as the other comes and goes', () => {
    const svg = svgOf(SELECT_ADD_LOOP_CURSOR);

    // The whole reason they are stacked rather than set side by side: the two
    // answer different questions and each keeps its own half of the column.
    expect(ringY(svg)).toBeLessThan(barY(svg));

    // And each sits where it sits whether or not the other is there.
    expect(ringY(svg)).toBe(ringY(svgOf(SELECT_LOOP_CURSOR)));
    expect(barY(svg)).toBe(barY(svgOf(SELECT_ADD_CURSOR)));
  });

  it('carries the ring alone when Alt is held without Shift', () => {
    // Alt+click still replaces the selection with the loop, so there is a
    // reach to report even with no sign to put beside it.
    const svg = svgOf(SELECT_LOOP_CURSOR);
    expect(svg).not.toContain(BAR);
    expect(svg).not.toContain(UPRIGHT);
  });

  it('aims every hotspot at the arrow tip, where the pick lands', () => {
    // Anywhere else and the element taken is not the one under the point of
    // the arrow. The trailing keyword covers a browser that refuses SVG.
    expect(SELECT_ADD_CURSOR.endsWith('") 3 2, copy')).toBe(true);
    expect(SELECT_ADD_LOOP_CURSOR.endsWith('") 3 2, copy')).toBe(true);
    for (const cursor of [
      SELECT_SUBTRACT_CURSOR,
      SELECT_LOOP_CURSOR,
      SELECT_SUBTRACT_LOOP_CURSOR,
    ]) {
      expect(cursor.endsWith('") 3 2, default')).toBe(true);
    }
  });

  it('escapes every SVG rather than trusting it raw in a URL', () => {
    for (const cursor of ALL) {
      const encoded = cursor.slice(cursor.indexOf(',') + 1).split('")')[0];
      expect(encoded).not.toMatch(/[<>#"]/);
      expect(decodeURIComponent(encoded)).toContain('<svg');
    }
  });

  it('draws every mark twice, so it reads over dark background and lit surface', () => {
    for (const cursor of ALL) {
      const svg = svgOf(cursor);
      expect(svg).toContain("stroke='#0b0b0b'");
      expect(svg).toContain("stroke='#f4f1ea'");
    }
  });

  it('keeps every mark inside the 32 pixels a cursor is allowed', () => {
    // Past 32 across, Windows drops the image and the fallback keyword is all
    // that is left. The halo is the widest stroke, so it sets the margin.
    const halo = 4.4 / 2;
    for (const cursor of ALL) expect(svgOf(cursor)).toContain("viewBox='0 0 32 32'");

    const svg = svgOf(SELECT_ADD_LOOP_CURSOR);
    expect(ringY(svg) - ringRadius(svg) - halo).toBeGreaterThan(0);
    // The upright reaches 4 below the bar, which is the lowest the marks go.
    expect(barY(svg) + 4 + halo).toBeLessThan(32);
  });
});
