import { DEFAULT_KEYMAP, formatBinding } from '@domain/keymap/keymap';
import { type ContextMenuEntry, ContextMenu } from '@shared/components';
import { CURSOR_SNAPS, useCursorActions, useEditorStore } from '@store/index';
import type { CursorSnapKind } from '@store/types';

/**
 * The key an entry actually answers to, or nothing when it answers to none.
 *
 * Read off the keymap the editor runs on rather than written out here, the way
 * the docs module builds its shortcut tables. Hand-written ones drifted: this
 * menu spent a while offering keys that were bound to something else, and keys
 * that were bound to nothing at all.
 */
function shortcut(id: string): string {
  const binding = DEFAULT_KEYMAP.find((entry) => entry.id === id);
  return binding ? ` (${formatBinding(binding).replace(/ \+ /g, '+').toUpperCase()})` : '';
}

/**
 * An entry's description with the key it answers to on the end.
 *
 * Every entry names its key, the disabled ones included: a user reading why an
 * entry cannot run now still learns what to press once it can.
 */
function hint(text: string, binding: string): string {
  return `${text}${shortcut(binding)}`;
}

/**
 * The viewport's right-click menu for the 3D cursor.
 *
 * The snap targets were resolved by the viewport at the moment of the click and
 * handed over in the store; this only turns them into entries. Targets the
 * click did not find are disabled rather than dropped, so the menu keeps the
 * same shape and the same muscle memory every time it opens.
 *
 * The entries below the rule are disabled the same way, by what the selection
 * allows: each one asks the store ahead of the click whether it would refuse,
 * and says so in its hint rather than waiting to be pressed for nothing.
 */
export function CursorMenu() {
  const menu = useEditorStore((state) => state.cursorMenu);
  const close = useEditorStore((state) => state.closeCursorMenu);
  const setCursor = useEditorStore((state) => state.setCursor);
  const snapCursor = useEditorStore((state) => state.snapCursor);
  const cursorToSelection = useEditorStore((state) => state.cursorToSelection);
  const cursorToSelectionOrigin = useEditorStore((state) => state.cursorToSelectionOrigin);
  const selectionToCursor = useEditorStore((state) => state.selectionToCursor);
  const originToCursor = useEditorStore((state) => state.originToCursor);
  const cursorVisible = useEditorStore((state) => state.overlays.cursor);
  const setOverlay = useEditorStore((state) => state.setOverlay);
  const can = useCursorActions();

  if (!menu) return null;

  const snap = (
    kind: CursorSnapKind,
    label: string,
    binding: string,
    available: string,
  ): ContextMenuEntry => {
    const target = menu.targets[kind];
    return {
      id: kind,
      label,
      disabled: target === null,
      // The miss is worded by the store, so the menu and the key report a
      // pointer that found nothing in the same words.
      hint: hint(target ? available : CURSOR_SNAPS[kind].missing, binding),
      onSelect: () => snapCursor(kind, menu.targets),
    };
  };

  const entries: ContextMenuEntry[] = [
    snap(
      'point',
      'PLACE CURSOR HERE',
      'cursorToPointer',
      'Put the cursor exactly where the pointer is',
    ),
    snap(
      'vertex',
      'CURSOR TO VERTEX',
      'cursorToVertex',
      'Snap the cursor onto the vertex under the pointer',
    ),
    snap(
      'edge',
      'CURSOR TO EDGE CENTRE',
      'cursorToEdge',
      'Snap the cursor to the midpoint of the edge under the pointer',
    ),
    snap(
      'face',
      'CURSOR TO FACE CENTRE',
      'cursorToFace',
      'Snap the cursor to the centre of the face under the pointer',
    ),
    { id: 'rule-1', separator: true },
    {
      id: 'cursor-to-selection',
      label: 'CURSOR TO SELECTION',
      disabled: !can.toSelection,
      hint: hint(
        can.toSelection
          ? 'Move the cursor onto the middle of the geometry that is selected'
          : 'Nothing selected for the cursor to move onto',
        'cursorToSelection',
      ),
      onSelect: cursorToSelection,
    },
    {
      id: 'cursor-to-selection-origin',
      label: 'CURSOR TO SELECTION ORIGIN',
      disabled: !can.toOrigin,
      hint: hint(
        can.toOrigin
          ? 'Move the cursor onto the origin instead: the amber square, and where the gizmo sits on the ORIGIN pivot. In edit mode, the origin of the object being edited'
          : 'Nothing selected to take an origin from',
        'cursorToSelectionOrigin',
      ),
      onSelect: cursorToSelectionOrigin,
    },
    {
      id: 'selection-to-cursor',
      label: 'SELECTION TO CURSOR',
      disabled: can.selectionToCursor !== 'ready',
      hint: hint(
        {
          ready: 'Move the selection so it lands on the cursor',
          none: 'Nothing selected to move onto the cursor',
          locked: 'Unlock the selection in the outliner to move it onto the cursor',
        }[can.selectionToCursor],
        'selectionToCursor',
      ),
      onSelect: selectionToCursor,
    },
    {
      id: 'origin-of-selected-to-cursor',
      label: 'ORIGIN OF SELECTED TO CURSOR',
      disabled: can.originToCursor !== 'ready',
      hint: hint(
        {
          ready:
            'Move the origin of every selected object onto the cursor, leaving the geometry where it stands',
          none: 'Nothing selected to move an origin of',
          locked: 'Unlock the selection in the outliner to move its origin onto the cursor',
          linked: 'Linked copies share one mesh, so the selection has to be made single-user first',
        }[can.originToCursor],
        'originToCursor',
      ),
      onSelect: originToCursor,
    },
    { id: 'rule-2', separator: true },
    {
      id: 'world-origin',
      label: 'CURSOR TO WORLD ORIGIN',
      hint: hint('Send the cursor back to 0, 0, 0', 'cursorToWorldOrigin'),
      onSelect: () => setCursor({ x: 0, y: 0, z: 0 }, 'Cursor to world origin'),
    },
    {
      id: 'visibility',
      label: cursorVisible ? 'HIDE CURSOR' : 'SHOW CURSOR',
      // Hiding only drops the overlay: the snap entries above still move the
      // cursor, and the pivot still uses wherever it was left.
      hint: hint(
        cursorVisible
          ? 'Stop showing the cursor without moving it'
          : 'Shows the cursor in the viewport again',
        'toggleCursor',
      ),
      onSelect: () => setOverlay({ cursor: !cursorVisible }),
    },
  ];

  return (
    <ContextMenu x={menu.x} y={menu.y} label="CURSOR MENU" entries={entries} onClose={close} />
  );
}
