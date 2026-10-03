export interface KeyBinding {
  id: string;
  /** `KeyboardEvent.key`, lower-cased for letters. Always what the overlay prints. */
  key: string;
  /**
   * The physical keys to match on in place of `key`. Any one of them fires it.
   *
   * Two separate things stop the axis views matching on the character. Shift
   * over the number row changes what the browser reports, and changes it
   * differently on every layout: Shift and 1 arrives as `!` on a US keyboard
   * and as `+` on a Swedish one. The numpad changes it again depending on
   * NumLock, where one key sends `1` or `End` according to a light on the
   * keyboard. The physical key is all that stays put through both, so these
   * match on that and keep `key` for what the overlay prints.
   */
  codes?: readonly string[];
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
  // Shift+G rather than Blender's double-tapped G: a binding that depends on
  // how fast the same key is pressed twice has nowhere to live in a table the
  // shortcut overlay reads straight out.
  {
    id: 'slide',
    key: 'g',
    shift: true,
    mode: 'edit',
    label: 'Slide: vertices along their edges, or selected edges across their faces',
    group: 'Transform',
  },

  // One key each, and each starts a drag rather than a fixed cut: a second way
  // in would be a second way to open a modal that already owns the pointer.
  {
    id: 'extrude',
    key: 'e',
    mode: 'edit',
    label: 'Extrude: drag the distance along the region normal',
    group: 'Modelling',
  },
  {
    id: 'inset',
    key: 'i',
    mode: 'edit',
    label: 'Inset: drag the thickness in toward the selection',
    group: 'Modelling',
  },
  {
    id: 'bevel',
    key: 'b',
    ctrl: true,
    mode: 'edit',
    label: 'Bevel: drag the width out from the selection',
    group: 'Modelling',
  },
  { id: 'loopCut', key: 'r', ctrl: true, label: 'Loop cut', mode: 'edit', group: 'Modelling' },
  {
    id: 'knife',
    key: 'k',
    mode: 'edit',
    label: 'Knife: click points on the mesh to cut new edges through its faces',
    group: 'Modelling',
  },
  { id: 'merge', key: 'm', label: 'Merge by distance', mode: 'edit', group: 'Modelling' },
  {
    id: 'recalculateNormals',
    key: 'n',
    shift: true,
    label: 'Recalculate normals, pointing them outward',
    group: 'Modelling',
  },
  {
    id: 'merge',
    key: 'm',
    mode: 'object',
    label: 'Merge the selected objects into the active one',
    group: 'Edit',
  },
  {
    id: 'bridge',
    key: 'b',
    alt: true,
    mode: 'edit',
    label: 'Bridge two open edge loops with a band of quads',
    group: 'Modelling',
  },
  {
    id: 'triangulate',
    key: 't',
    alt: true,
    mode: 'edit',
    label: 'Triangulate every face',
    group: 'Modelling',
  },
  {
    id: 'trisToQuads',
    key: 'j',
    alt: true,
    mode: 'edit',
    label: 'Merge adjacent, near-coplanar triangle pairs back into quads',
    group: 'Modelling',
  },
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
    label: 'Subdivide: splits selected edges at their midpoint, or cuts up faces',
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
    id: 'delete',
    key: 'delete',
    mode: 'object',
    label: 'Delete the selected object(s)',
    group: 'Edit',
  },
  {
    id: 'deleteMenu',
    key: 'delete',
    mode: 'edit',
    label: 'Delete menu: delete or dissolve the selected vertices, edges or faces',
    group: 'Edit',
  },
  { id: 'duplicate', key: 'd', shift: true, label: 'Duplicate', mode: 'object', group: 'Edit' },
  {
    id: 'linkedDuplicate',
    key: 'd',
    alt: true,
    mode: 'object',
    label: 'Linked duplicate: the copy shares the original mesh data',
    group: 'Edit',
  },
  {
    id: 'separate',
    key: 'p',
    mode: 'object',
    label: 'Separate the loose parts into an object each',
    group: 'Edit',
  },
  {
    id: 'group',
    key: 'g',
    ctrl: true,
    mode: 'object',
    label: 'Group the selected objects into a folder in the outliner',
    group: 'Edit',
  },
  {
    id: 'applyTransform',
    key: 'a',
    ctrl: true,
    mode: 'object',
    label: 'Apply rotation and scale into the mesh',
    group: 'Edit',
  },
  { id: 'undo', key: 'z', ctrl: true, label: 'Undo', group: 'Edit' },
  { id: 'redo', key: 'z', ctrl: true, shift: true, label: 'Redo', group: 'Edit' },

  {
    id: 'selectTool',
    key: 'v',
    label: 'Select tool: press again for the next region shape',
    group: 'Selection',
  },
  {
    id: 'clearSelection',
    key: 'escape',
    label: 'Clear the selection and put the gizmo away',
    group: 'Selection',
  },
  { id: 'selectAll', key: 'a', label: 'Select all', group: 'Selection' },
  { id: 'deselectAll', key: 'a', alt: true, label: 'Deselect all', group: 'Selection' },
  { id: 'invertSelection', key: 'i', ctrl: true, label: 'Invert selection', group: 'Selection' },
  {
    id: 'selectFaceLoop',
    key: 'l',
    alt: true,
    mode: 'edit',
    label: 'Select the face loop running through two adjacent faces',
    group: 'Selection',
  },
  // Brackets rather than Blender's Ctrl+NumPad +/-: half the keyboards this
  // runs on have no numpad, and Ctrl with the +/- row is browser zoom, which
  // preventDefault does not reliably hold back.
  {
    id: 'growSelection',
    key: ']',
    mode: 'edit',
    label: 'Grow the selection to the neighbouring ring',
    group: 'Selection',
  },
  {
    id: 'shrinkSelection',
    key: '[',
    mode: 'edit',
    label: 'Shrink the selection back from its border',
    group: 'Selection',
  },

  // C moves the cursor and V brings things to it. Alt+Shift over either one
  // works on origins rather than on the geometry, and Alt alone over V, E and F
  // snaps to the vertex, edge or face the pointer is on.
  { id: 'cursorToPointer', key: 'c', label: 'Place the cursor under the pointer', group: 'Cursor' },
  {
    id: 'cursorToVertex',
    key: 'v',
    alt: true,
    label: 'Cursor to the vertex under the pointer',
    group: 'Cursor',
  },
  {
    id: 'cursorToEdge',
    key: 'e',
    alt: true,
    label: 'Cursor to the centre of the edge under the pointer',
    group: 'Cursor',
  },
  {
    id: 'cursorToFace',
    key: 'f',
    alt: true,
    label: 'Cursor to the centre of the face under the pointer',
    group: 'Cursor',
  },
  {
    id: 'cursorToWorldOrigin',
    key: 'c',
    shift: true,
    label: 'Cursor to world origin',
    group: 'Cursor',
  },
  {
    id: 'cursorToSelection',
    key: 'c',
    ctrl: true,
    shift: true,
    label: 'Cursor to selection',
    group: 'Cursor',
  },
  {
    id: 'cursorToSelectionOrigin',
    key: 'c',
    alt: true,
    shift: true,
    label: 'Cursor to the origin of the selection',
    group: 'Cursor',
  },
  { id: 'selectionToCursor', key: 'v', shift: true, label: 'Selection to cursor', group: 'Cursor' },
  {
    id: 'originToCursor',
    key: 'v',
    alt: true,
    shift: true,
    label: 'Origins of the selected objects to the cursor',
    group: 'Cursor',
  },
  { id: 'toggleCursor', key: 'c', alt: true, label: 'Hide or show the cursor', group: 'Cursor' },
  // Ctrl rather than Shift: shifting a punctuation key changes the character
  // the browser reports, so `Shift+.` arrives as `>` and never matches.
  {
    id: 'togglePivot',
    key: '.',
    ctrl: true,
    label: 'Cycle pivot: origin, median, cursor',
    group: 'Cursor',
  },

  { id: 'frameSelected', key: '.', label: 'Frame selected', group: 'View' },
  { id: 'frameAll', key: 'home', label: 'Frame all', group: 'View' },
  // Blender's numpad 5, and the number row's 5 beside it. On `codes` like the
  // camera keys below, so that the numpad answers with NumLock off as well.
  {
    id: 'toggleOrtho',
    key: '5',
    codes: ['Digit5', 'Numpad5'],
    label: 'Orthographic / perspective',
    group: 'View',
  },

  // The camera on the keyboard: Blender's numpad arrangement, with Shift in
  // front of it, on the number row and the numpad alike.
  //
  // Both blocks carry it because neither one is always there: a laptop has no
  // numpad, and a hand already resting on one should not have to travel. The
  // numbers mean what they mean in Blender, since that is the muscle memory
  // the arrangement exists to serve. Odd keys jump to a view, even keys turn
  // the camera by a step, 9 walks round to the far side, and Ctrl reaches the
  // opposite of each view. Shift is what keeps all of it clear of the vertex,
  // edge and face select modes sitting on 1, 2 and 3.
  {
    id: 'viewFront',
    key: '1',
    codes: ['Digit1', 'Numpad1'],
    shift: true,
    label: 'Front view',
    group: 'View',
  },
  {
    id: 'viewBack',
    key: '1',
    codes: ['Digit1', 'Numpad1'],
    ctrl: true,
    shift: true,
    label: 'Back view',
    group: 'View',
  },
  {
    id: 'viewRight',
    key: '3',
    codes: ['Digit3', 'Numpad3'],
    shift: true,
    label: 'Right view',
    group: 'View',
  },
  {
    id: 'viewLeft',
    key: '3',
    codes: ['Digit3', 'Numpad3'],
    ctrl: true,
    shift: true,
    label: 'Left view',
    group: 'View',
  },
  {
    id: 'viewTop',
    key: '7',
    codes: ['Digit7', 'Numpad7'],
    shift: true,
    label: 'Top view',
    group: 'View',
  },
  {
    id: 'viewBottom',
    key: '7',
    codes: ['Digit7', 'Numpad7'],
    ctrl: true,
    shift: true,
    label: 'Bottom view',
    group: 'View',
  },
  {
    id: 'orbitLeft',
    key: '4',
    codes: ['Digit4', 'Numpad4'],
    shift: true,
    label: 'Orbit left a step, fifteen degrees',
    group: 'View',
  },
  {
    id: 'orbitRight',
    key: '6',
    codes: ['Digit6', 'Numpad6'],
    shift: true,
    label: 'Orbit right a step, fifteen degrees',
    group: 'View',
  },
  {
    id: 'orbitUp',
    key: '8',
    codes: ['Digit8', 'Numpad8'],
    shift: true,
    label: 'Orbit up a step, fifteen degrees',
    group: 'View',
  },
  {
    id: 'orbitDown',
    key: '2',
    codes: ['Digit2', 'Numpad2'],
    shift: true,
    label: 'Orbit down a step, fifteen degrees',
    group: 'View',
  },
  {
    id: 'orbitOpposite',
    key: '9',
    codes: ['Digit9', 'Numpad9'],
    shift: true,
    label: 'Look from the opposite side, the same distance out',
    group: 'View',
  },
  {
    id: 'toggleOrtho',
    key: '5',
    codes: ['Digit5', 'Numpad5'],
    shift: true,
    label: 'Orthographic / perspective',
    group: 'View',
  },
  { id: 'toggleWireframe', key: 'z', shift: true, label: 'Cycle shading', group: 'View' },

  { id: 'save', key: 's', ctrl: true, label: 'Save project', group: 'File' },
  {
    id: 'saveAs',
    key: 's',
    ctrl: true,
    shift: true,
    label: 'Save project as a new file',
    group: 'File',
  },
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
      if (binding.codes ? !binding.codes.includes(event.code) : binding.key !== key) return false;
      return (
        Boolean(binding.ctrl) === (event.ctrlKey || event.metaKey) &&
        Boolean(binding.shift) === event.shiftKey &&
        Boolean(binding.alt) === event.altKey
      );
    })
    .sort(
      (a, b) =>
        Number(Boolean(b.ctrl)) +
        Number(Boolean(b.shift)) +
        Number(Boolean(b.alt)) -
        (Number(Boolean(a.ctrl)) + Number(Boolean(a.shift)) + Number(Boolean(a.alt))),
    );

  return candidates[0] ?? null;
}

/**
 * Which of the browser's reload keys a keystroke is, or null when it is none.
 *
 * Every browser reloads on F5 and on Ctrl+R, takes Shift or Ctrl in front of
 * either one as the reload that skips the cache, and reads Cmd for Ctrl on a
 * Mac. None of them may reach the browser over unsaved changes: a reload opens
 * a fresh scene, and whatever is in no file by then is gone.
 *
 * `ask` is a reload the user meant, so it is worth offering the save first
 * when there is anything to save.
 * `loopCut` is Ctrl+R, which the keymap has taken for the loop cut, so it is
 * only a reload as far as the browser is concerned.
 *
 * The physical key counts alongside the character for the Ctrl+R pair: a
 * layout that puts something other than `r` there, Cyrillic among them, still
 * reloads on that key because the browser reads the position.
 */
export function reloadShortcut(event: KeyboardEvent): 'ask' | 'loopCut' | null {
  if (event.key === 'F5') return 'ask';
  if (!(event.ctrlKey || event.metaKey)) return null;
  if (event.key.toLowerCase() !== 'r' && event.code !== 'KeyR') return null;
  return event.shiftKey ? 'ask' : 'loopCut';
}
