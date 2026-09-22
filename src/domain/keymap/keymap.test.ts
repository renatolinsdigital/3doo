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

  it('gives extrude, inset and bevel one key each', () => {
    // Each of the three starts a drag that owns the pointer until it is
    // confirmed. A second key onto the same one is a second way into that, and
    // the overlay would list the operator twice with nothing to tell them apart.
    for (const id of ['extrude', 'inset', 'bevel']) {
      expect(DEFAULT_KEYMAP.filter((binding) => binding.id === id)).toHaveLength(1);
    }
  });

  it('has no duplicate binding signatures within a mode', () => {
    const seen = new Set<string>();
    for (const binding of DEFAULT_KEYMAP) {
      const signature = [
        binding.codes?.join(' ') ?? binding.key,
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
  function press(key: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
    return matchBinding(
      new KeyboardEvent('keydown', {
        key,
        ctrlKey: modifiers.ctrl ?? false,
        shiftKey: modifiers.shift ?? false,
        altKey: modifiers.alt ?? false,
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

  it('gives every entry of the cursor menu a key of its own', () => {
    // The menu reads these off the keymap, so an entry with no binding shows
    // no key at all and looks like one the keyboard cannot reach.
    expect(press('c')?.id).toBe('cursorToPointer');
    expect(press('V', { alt: true })?.id).toBe('cursorToVertex');
    expect(press('E', { alt: true })?.id).toBe('cursorToEdge');
    expect(press('F', { alt: true })?.id).toBe('cursorToFace');
    expect(press('C', { alt: true, shift: true })?.id).toBe('cursorToSelectionOrigin');
    expect(press('V', { alt: true, shift: true })?.id).toBe('originToCursor');
    expect(press('C', { alt: true })?.id).toBe('toggleCursor');
  });

  it('keeps Alt and Alt+Shift apart on the same letter', () => {
    // Alt+V snaps to a vertex and Alt+Shift+V moves origins: one modifier
    // between them, and `matchBinding` compares all three.
    expect(press('V')?.id).toBe('selectTool');
    expect(press('E', { alt: true })?.id).not.toBe('extrude');
  });

  it('leaves the unmodified keys they sit on alone', () => {
    expect(press('.')?.id).toBe('frameSelected');
  });

  it('binds nothing to a shifted key that never arrives as itself', () => {
    // Shift over a letter reports the upper case of that same letter, which
    // lower-casing puts back. Over a digit or a punctuation key it reports a
    // different character entirely, so those have to match on `codes`. The one
    // exception is the overlay, bound to the shifted character itself.
    const unreachable = DEFAULT_KEYMAP.filter(
      (binding) =>
        binding.shift && !binding.codes && binding.key.length === 1 && !/[a-z]/.test(binding.key),
    );
    expect(unreachable.map((binding) => binding.id)).toEqual(['shortcuts']);
  });
});
describe('the camera on the keyboard', () => {
  /** What a US layout sends for Shift over the number row. */
  const SHIFTED: Record<number, string> = {
    1: '!',
    2: '@',
    3: '#',
    4: '$',
    5: '%',
    6: '^',
    7: '&',
    8: '*',
    9: '(',
  };

  /**
   * What a numpad key sends with NumLock off, which is also what Shift over it
   * sends with NumLock on, since the modifier suppresses the digit.
   */
  const NAVIGATION: Record<number, string> = {
    1: 'End',
    2: 'ArrowDown',
    3: 'PageDown',
    4: 'ArrowLeft',
    5: 'Clear',
    6: 'ArrowRight',
    7: 'Home',
    8: 'ArrowUp',
    9: 'PageUp',
  };

  const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

  function row(digit: number, ctrl = false, mode: 'object' | 'edit' = 'object') {
    return matchBinding(
      keyEvent(SHIFTED[digit], { code: `Digit${digit}`, shiftKey: true, ctrlKey: ctrl }),
      mode,
    );
  }

  function numpad(digit: number, ctrl = false, mode: 'object' | 'edit' = 'object') {
    return matchBinding(
      keyEvent(NAVIGATION[digit], { code: `Numpad${digit}`, shiftKey: true, ctrlKey: ctrl }),
      mode,
    );
  }

  it('lays the numbers out the way Blender does: odd jumps, even orbits', () => {
    expect([row(1)?.id, row(3)?.id, row(7)?.id]).toEqual(['viewFront', 'viewRight', 'viewTop']);
    expect([row(4)?.id, row(6)?.id, row(8)?.id, row(2)?.id]).toEqual([
      'orbitLeft',
      'orbitRight',
      'orbitUp',
      'orbitDown',
    ]);
    expect(row(9)?.id).toBe('orbitOpposite');
    expect(row(5)?.id).toBe('toggleOrtho');
  });

  it('reaches the opposite of each view with Ctrl, as Blender does', () => {
    expect([row(1, true)?.id, row(3, true)?.id, row(7, true)?.id]).toEqual([
      'viewBack',
      'viewLeft',
      'viewBottom',
    ]);
  });

  it('answers the same on the number row and the numpad', () => {
    // One arrangement on both blocks: a laptop has no numpad, and a hand
    // already resting on one should not have to travel to the row.
    for (const ctrl of [false, true]) {
      expect(DIGITS.map((digit) => numpad(digit, ctrl)?.id ?? null)).toEqual(
        DIGITS.map((digit) => row(digit, ctrl)?.id ?? null),
      );
    }
  });

  it('reads the physical key rather than the character the layout sends', () => {
    // A Swedish keyboard sends + for Shift and 1, and still looks at the front.
    expect(matchBinding(keyEvent('+', { code: 'Digit1', shiftKey: true }), 'object')?.id).toBe(
      'viewFront',
    );
  });

  it('answers whichever way NumLock is set', () => {
    // NumLock on sends the digit, off sends the navigation key it doubles as.
    // Both carry the same code, which is the whole reason these match on it.
    for (const key of ['4', 'ArrowLeft']) {
      expect(matchBinding(keyEvent(key, { code: 'Numpad4', shiftKey: true }), 'object')?.id).toBe(
        'orbitLeft',
      );
    }
  });

  it('works in edit mode too, where the plain digits are taken', () => {
    expect(row(1, false, 'edit')?.id).toBe('viewFront');
    expect(row(4, false, 'edit')?.id).toBe('orbitLeft');
    expect(row(7, true, 'edit')?.id).toBe('viewBottom');
  });

  it('leaves the unshifted digits to the select modes', () => {
    expect(matchBinding(keyEvent('1', { code: 'Digit1' }), 'edit')?.id).toBe('selectVertex');
    expect(matchBinding(keyEvent('2', { code: 'Digit2' }), 'edit')?.id).toBe('selectEdge');
    expect(matchBinding(keyEvent('3', { code: 'Digit3' }), 'edit')?.id).toBe('selectFace');
  });

  it('gives every camera key both blocks, and nothing only one of them', () => {
    // A key that reached only one block would be the gap nobody notices until
    // they are on the other keyboard.
    const camera = DEFAULT_KEYMAP.filter(
      (binding) => binding.id.startsWith('view') || binding.id.startsWith('orbit'),
    );
    expect(camera).toHaveLength(6 + 5);
    for (const binding of camera) {
      expect(binding.codes).toEqual([`Digit${binding.key}`, `Numpad${binding.key}`]);
    }
  });

  it('prints the digit, not the character Shift makes of it', () => {
    const top = DEFAULT_KEYMAP.find((binding) => binding.id === 'viewTop');
    expect(top && formatBinding(top)).toBe('Shift + 7');

    const bottom = DEFAULT_KEYMAP.find((binding) => binding.id === 'viewBottom');
    expect(bottom && formatBinding(bottom)).toBe('Ctrl + Shift + 7');
  });

  it('keeps the whole block behind Shift, so the plain keys stay free', () => {
    // Except 5, which toggles orthographic either way: that one is Blender's
    // own and costs nothing to leave reachable without the modifier.
    const plain = (digit: number) =>
      matchBinding(keyEvent(NAVIGATION[digit], { code: `Numpad${digit}` }), 'object');

    expect(plain(4)).toBeNull();
    expect(plain(8)).toBeNull();
    expect(plain(5)?.id).toBe('toggleOrtho');
    // 7 with NumLock off is the Home key, which already frames the scene.
    // That is the keyboard doing it rather than the keymap, and it is the
    // reason the camera sits behind Shift rather than on the bare numpad.
    expect(plain(7)?.id).toBe('frameAll');
  });
});
