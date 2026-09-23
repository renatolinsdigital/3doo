import { describe, expect, it } from 'vitest';

import { type HistoryEntry, type ProjectDocument, serializeProject, vec3 } from '@kernel/index';

import { storableHistory } from './autosave';

/** A document whose only weight is a mesh of `verts` vertices. */
function scene(name: string, verts: number): ProjectDocument {
  const document = serializeProject(name, [], vec3(), null);
  document.objects.push({
    id: name,
    name,
    transform: { position: vec3(), rotation: vec3(), scale: vec3(1, 1, 1) },
    visible: true,
    locked: false,
    parentId: null,
    groupId: null,
    materials: [],
    modifiers: [],
    activeMaterial: 0,
    mesh: {
      version: 1,
      positions: new Array(verts * 3).fill(0),
      faces: [],
      materialIndices: [],
      smooth: [],
      uvs: [],
      wireEdges: [],
      sharpEdges: [],
      selection: { verts: [], edges: [], faces: [] },
    },
  });
  return document;
}

function steps(count: number, verts: number): HistoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `op${index}`,
    document: scene(`d${index}`, verts),
  }));
}

describe('what the autosave keeps of the undo timeline', () => {
  it('keeps every step of a scene light enough to hold them all', () => {
    const history = { past: steps(50, 1000), future: steps(2, 1000) };

    const stored = storableHistory(history);

    expect(stored?.past).toHaveLength(50);
    expect(stored?.future).toHaveLength(2);
  });

  it('keeps the newest steps of a scene too heavy for the whole timeline', () => {
    // 120k vertices a step: two fit the budget, the rest cannot.
    const history = { past: steps(50, 120_000), future: [] };

    const stored = storableHistory(history);

    // The end of the array is the next undo, so it is the end that survives.
    expect(stored?.past.map((entry) => entry.label)).toEqual(['op48', 'op49']);
  });

  it('spends the budget on undo before redo', () => {
    const history = { past: steps(2, 120_000), future: steps(2, 120_000) };

    const stored = storableHistory(history);

    expect(stored?.past).toHaveLength(2);
    expect(stored?.future).toHaveLength(0);
  });

  it('stores nothing at all when a single step will not fit', () => {
    const history = { past: steps(3, 400_000), future: [] };

    // Better than a record the size of a video file written every tick.
    expect(storableHistory(history)).toBeUndefined();
  });
});
