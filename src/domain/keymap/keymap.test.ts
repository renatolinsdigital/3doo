import { describe, expect, it } from 'vitest';

import { DEFAULT_KEYMAP, formatBinding, matchBinding } from './keymap';

function keyEvent(key: string, modifiers: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, ...modifiers });
}

describe('keymap', () => {
  it('matches a plain key', () => {
    expect(matchBinding(keyEvent('g'), 'object')?.id).toBe('move');
  });

  it('prefers the binding with more modifiers', () => {
    // Ctrl+Shift+Z must win over Ctrl+Z, which also matches the key and Ctrl.
    expect(matchBinding(keyEvent('z', { ctrlKey: true, shiftKey: true }), 'object')?.id).toBe(
      'redo',
    );
    expect(matchBinding(keyEvent('z', { ctrlKey: true }), 'object')?.id).toBe('undo');
  });

  it('honours mode restrictions', () => {
    expect(matchBinding(keyEvent('e'), 'edit')?.id).toBe('extrude');
    expect(matchBinding(keyEvent('e'), 'object')).toBeNull();
  });

  it('splits X and Delete into delete and dissolve', () => {
    expect(matchBinding(keyEvent('x'), 'edit')?.id).toBe('delete');
    expect(matchBinding(keyEvent('Delete'), 'edit')?.id).toBe('dissolve');

    // In object mode both keys remove the object, so they share one action.
    expect(matchBinding(keyEvent('x'), 'object')?.id).toBe('delete');
    expect(matchBinding(keyEvent('Delete'), 'object')?.id).toBe('dissolve');
  });

  it('maps M to a merge in either mode, to a different one in each', () => {
    // Same key and the same word, but the object-mode one folds objects
    // together while the edit-mode one welds vertices by distance.
    expect(matchBinding(keyEvent('m'), 'object')?.label).toMatch(/into the active one/);
    expect(matchBinding(keyEvent('m'), 'edit')?.label).toMatch(/by distance/);
  });

  it('binds the object operations that had no key of their own', () => {
    expect(matchBinding(keyEvent('p'), 'object')?.id).toBe('separate');
    expect(matchBinding(keyEvent('a', { ctrlKey: true }), 'object')?.id).toBe('applyTransform');
    expect(matchBinding(keyEvent('d', { altKey: true }), 'object')?.id).toBe('linkedDuplicate');
    expect(matchBinding(keyEvent('n', { shiftKey: true }), 'object')?.id).toBe(
      'recalculateNormals',
    );

    // Three of them are object operations, so edit mode leaves those keys free.
    expect(matchBinding(keyEvent('p'), 'edit')).toBeNull();
    expect(matchBinding(keyEvent('a', { ctrlKey: true }), 'edit')).toBeNull();
    expect(matchBinding(keyEvent('d', { altKey: true }), 'edit')).toBeNull();
  });

  it('keeps plain A and Alt+A on selection, beside the new Ctrl+A', () => {
    expect(matchBinding(keyEvent('a'), 'object')?.id).toBe('selectAll');
    expect(matchBinding(keyEvent('a', { altKey: true }), 'object')?.id).toBe('deselectAll');
  });

  it('maps J to connect, in edit mode only', () => {
    expect(matchBinding(keyEvent('j'), 'edit')?.id).toBe('connect');
    expect(matchBinding(keyEvent('j'), 'object')).toBeNull();
  });

  it('treats Meta as Ctrl for macOS users', () => {
    expect(matchBinding(keyEvent('z', { metaKey: true }), 'object')?.id).toBe('undo');
  });

  it('returns null when nothing matches', () => {
    expect(matchBinding(keyEvent('q'), 'object')).toBeNull();
  });

  it('binds the select tool and the way out of a selection', () => {
    expect(matchBinding(keyEvent('v'), 'object')?.id).toBe('selectTool');
    expect(matchBinding(keyEvent('Escape'), 'object')?.id).toBe('clearSelection');
    expect(matchBinding(keyEvent('Escape'), 'edit')?.id).toBe('clearSelection');
    // Shift+V still sends the selection to the cursor.
    expect(matchBinding(keyEvent('v', { shiftKey: true }), 'object')?.id).toBe('selectionToCursor');
  });

  it('formats bindings for the overlay', () => {
    const redo = DEFAULT_KEYMAP.find((binding) => binding.id === 'redo');
    expect(redo && formatBinding(redo)).toBe('Ctrl + Shift + Z');
  });

  it('binds the edit operations that had no key of their own', () => {
    const edit = (key: string, modifiers: Partial<KeyboardEventInit> = {}) =>
      matchBinding(keyEvent(key, modifiers), 'edit')?.id;

    expect(edit('l', { altKey: true })).toBe('selectFaceLoop');
    expect(edit(']')).toBe('growSelection');
    expect(edit('[')).toBe('shrinkSelection');
    expect(edit('b', { altKey: true })).toBe('bridge');
    expect(edit('t', { altKey: true })).toBe('triangulate');
    expect(edit('j', { altKey: true })).toBe('trisToQuads');
  });

  it('keeps the new Alt bindings clear of the plain keys they sit on', () => {
    // Alt+J is tris-to-quads, J alone is still connect: `matchBinding` compares
    // every modifier, so the two cannot shadow each other.
    expect(matchBinding(keyEvent('j'), 'edit')?.id).toBe('connect');
    expect(matchBinding(keyEvent('b', { ctrlKey: true }), 'edit')?.id).toBe('bevel');
    expect(matchBinding(keyEvent('t'), 'edit')).toBeNull();
    expect(matchBinding(keyEvent('l'), 'edit')).toBeNull();
  });

  it('leaves the new edit bindings out of object mode', () => {
    for (const [key, modifiers] of [
      ['l', { altKey: true }],
      [']', {}],
      ['[', {}],
      ['b', { altKey: true }],
    ] as const) {
      expect(matchBinding(keyEvent(key, modifiers), 'object')).toBeNull();
    }
  });

  it('stays off the browser shortcuts preventDefault cannot hold back', () => {
    // Ctrl+T opens a tab and Ctrl with +/- is zoom, neither of which the page
    // can suppress, which is why grow and shrink are on brackets and the
    // clean-up operators are on Alt.
    const reserved = DEFAULT_KEYMAP.filter(
      (binding) => binding.ctrl && ['t', 'n', 'w', '+', '-', '='].includes(binding.key),
    );
    expect(reserved).toEqual([]);
  });

  it('has no duplicate binding signatures within a mode', () => {
    const seen = new Set<string>();
    for (const binding of DEFAULT_KEYMAP) {
      const signature = [
        binding.key,
        binding.ctrl ? 'c' : '',
        binding.shift ? 's' : '',
        binding.alt ? 'a' : '',
        binding.mode ?? 'both',
      ].join('|');
      expect(seen.has(signature)).toBe(false);
      seen.add(signature);
    }
  });
});

describe('3D cursor bindings', () => {
  function press(key: string, modifiers: { ctrl?: boolean; shift?: boolean } = {}) {
    return matchBinding(
      new KeyboardEvent('keydown', {
        key,
        ctrlKey: modifiers.ctrl ?? false,
        shiftKey: modifiers.shift ?? false,
      }),
      'object',
    );
  }

  it('resolves every cursor shortcut from the character the browser reports', () => {
    // Shift over a letter reports the upper case of the same key; over
    // punctuation it reports a different character entirely, which is why the
    // pivot toggle is on Ctrl.
    expect(press('C', { shift: true })?.id).toBe('cursorToWorldOrigin');
    expect(press('C', { ctrl: true, shift: true })?.id).toBe('cursorToSelection');
    expect(press('V', { shift: true })?.id).toBe('selectionToCursor');
    expect(press('.', { ctrl: true })?.id).toBe('togglePivot');
  });

  it('leaves the unmodified keys they sit on alone', () => {
    expect(press('.')?.id).toBe('frameSelected');
  });

  it('binds nothing to a shifted punctuation key, which never arrives as itself', () => {
    const unreachable = DEFAULT_KEYMAP.filter(
      (binding) => binding.shift && binding.key.length === 1 && !/[a-z0-9]/.test(binding.key),
    );
    expect(unreachable.map((binding) => binding.id)).toEqual(['shortcuts']);
  });
});
