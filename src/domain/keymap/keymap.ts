export interface KeyBinding {
  id: string;
  /** `KeyboardEvent.key`, lower-cased for letters. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  label: string;
  /** Which mode the binding applies in; omitted means both. */
  mode?: 'object' | 'edit';
  group: string;
}

/**
 * Blender defaults, because that is the muscle memory users arrive with.
 *
 * The table is data rather than a switch statement so the shortcut overlay and
 * the eventual keymap editor read from the same source as the handler.
 */
export const DEFAULT_KEYMAP: KeyBinding[] = [
  { id: 'toggleMode', key: 'tab', label: 'Toggle edit mode', group: 'Modes' },
  { id: 'selectVertex', key: '1', label: 'Vertex select', mode: 'edit', group: 'Modes' },
  { id: 'selectEdge', key: '2', label: 'Edge select', mode: 'edit', group: 'Modes' },
  { id: 'selectFace', key: '3', label: 'Face select', mode: 'edit', group: 'Modes' },

  { id: 'move', key: 'g', label: 'Move', group: 'Transform' },
  { id: 'rotate', key: 'r', label: 'Rotate', group: 'Transform' },
  { id: 'scale', key: 's', label: 'Scale', group: 'Transform' },

  { id: 'extrude', key: 'e', label: 'Extrude', mode: 'edit', group: 'Modelling' },
  { id: 'inset', key: 'i', label: 'Inset', mode: 'edit', group: 'Modelling' },
  { id: 'bevel', key: 'b', ctrl: true, label: 'Bevel', mode: 'edit', group: 'Modelling' },
  { id: 'loopCut', key: 'r', ctrl: true, label: 'Loop cut', mode: 'edit', group: 'Modelling' },
  { id: 'merge', key: 'm', label: 'Merge by distance', mode: 'edit', group: 'Modelling' },
  {
    id: 'fill',
    key: 'f',
    label: 'Fill a boundary loop with a face',
    mode: 'edit',
    group: 'Modelling',
  },
  {
    id: 'connect',
    key: 'j',
    mode: 'edit',
    label: 'Connect two vertices with an edge, splitting the face',
    group: 'Modelling',
  },
  {
    id: 'subdivide',
    key: 'd',
    ctrl: true,
    mode: 'edit',
    label: 'Subdivide — splits selected edges at their midpoint, or cuts up faces',
    group: 'Modelling',
  },

  { id: 'delete', key: 'x', mode: 'object', label: 'Delete the selected object(s)', group: 'Edit' },
  {
    id: 'delete',
    key: 'x',
    mode: 'edit',
    label: 'Delete the selection outright, leaving a hole',
    group: 'Edit',
  },
  {
    id: 'dissolve',
    key: 'delete',
    mode: 'object',
    label: 'Delete the selected object(s)',
    group: 'Edit',
  },
  {
    id: 'dissolve',
    key: 'delete',
    mode: 'edit',
    label: 'Dissolve the selection, keeping the surrounding surface',
    group: 'Edit',
  },
  { id: 'duplicate', key: 'd', shift: true, label: 'Duplicate', mode: 'object', group: 'Edit' },
  { id: 'undo', key: 'z', ctrl: true, label: 'Undo', group: 'Edit' },
  { id: 'redo', key: 'z', ctrl: true, shift: true, label: 'Redo', group: 'Edit' },

  { id: 'selectAll', key: 'a', label: 'Select all', group: 'Selection' },
  { id: 'deselectAll', key: 'a', alt: true, label: 'Deselect all', group: 'Selection' },
  { id: 'invertSelection', key: 'i', ctrl: true, label: 'Invert selection', group: 'Selection' },

  { id: 'cursorToWorldOrigin', key: 'c', shift: true, label: 'Cursor to world origin', group: 'Cursor' },
  { id: 'cursorToSelection', key: 'c', ctrl: true, shift: true, label: 'Cursor to selection', group: 'Cursor' },
  { id: 'selectionToCursor', key: 'v', shift: true, label: 'Selection to cursor', group: 'Cursor' },
  // Ctrl rather than Shift: shifting a punctuation key changes the character
  // the browser reports, so `Shift+.` arrives as `>` and never matches.
  { id: 'togglePivot', key: '.', ctrl: true, label: 'Toggle median / cursor pivot', group: 'Cursor' },

  { id: 'frameSelected', key: '.', label: 'Frame selected', group: 'View' },
  { id: 'frameAll', key: 'home', label: 'Frame all', group: 'View' },
  { id: 'toggleOrtho', key: '5', label: 'Orthographic / perspective', group: 'View' },
  { id: 'viewFront', key: '1', ctrl: true, label: 'Front view', group: 'View' },
  { id: 'viewSide', key: '3', ctrl: true, label: 'Side view', group: 'View' },
  { id: 'viewTop', key: '7', label: 'Top view', group: 'View' },
  { id: 'toggleWireframe', key: 'z', shift: true, label: 'Cycle shading', group: 'View' },

  { id: 'save', key: 's', ctrl: true, label: 'Save project', group: 'File' },
  { id: 'open', key: 'o', ctrl: true, label: 'Open project', group: 'File' },
  { id: 'export', key: 'e', ctrl: true, label: 'Export', group: 'File' },
  { id: 'shortcuts', key: '?', shift: true, label: 'Shortcut overlay', group: 'Help' },
];

export function formatBinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.shift) parts.push('Shift');
  if (binding.alt) parts.push('Alt');

  const key = binding.key === ' ' ? 'Space' : binding.key;
  parts.push(key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
  return parts.join(' + ');
}

/**
 * Finds the binding an event matches.
 *
 * Bindings with more modifiers are tested first so `Ctrl+Shift+Z` wins over the
 * plain `Ctrl+Z` that would otherwise also match.
 */
export function matchBinding(
  event: KeyboardEvent,
  mode: 'object' | 'edit',
  keymap: readonly KeyBinding[] = DEFAULT_KEYMAP,
): KeyBinding | null {
  const key = event.key.toLowerCase();

  const candidates = keymap
    .filter((binding) => {
      if (binding.mode && binding.mode !== mode) return false;
      if (binding.key !== key) return false;
      return (
        Boolean(binding.ctrl) === (event.ctrlKey || event.metaKey) &&
        Boolean(binding.shift) === event.shiftKey &&
        Boolean(binding.alt) === event.altKey
      );
    })
    .sort(
      (a, b) =>
        Number(Boolean(b.ctrl)) + Number(Boolean(b.shift)) + Number(Boolean(b.alt)) -
        (Number(Boolean(a.ctrl)) + Number(Boolean(a.shift)) + Number(Boolean(a.alt))),
    );

  return candidates[0] ?? null;
}
