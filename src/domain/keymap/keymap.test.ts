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

  it('formats bindings for the overlay', () => {
    const redo = DEFAULT_KEYMAP.find((binding) => binding.id === 'redo');
    expect(redo && formatBinding(redo)).toBe('Ctrl + Shift + Z');
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
