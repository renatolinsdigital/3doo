import { DEFAULT_KEYMAP, formatBinding } from '@domain/keymap/keymap';
import type { Vec3 } from '@kernel/index';
import { type ContextMenuEntry, ContextMenu } from '@shared/components';
import { useEditorStore } from '@store/index';

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
 * The viewport's right-click menu for the 3D cursor.
 *
 * The snap targets were resolved by the viewport at the moment of the click and
 * handed over in the store; this only turns them into entries. Targets the
 * click did not find are disabled rather than dropped, so the menu keeps the
 * same shape and the same muscle memory every time it opens.
 */
export function CursorMenu() {
  const menu = useEditorStore((state) => state.cursorMenu);
  const close = useEditorStore((state) => state.closeCursorMenu);
  const setCursor = useEditorStore((state) => state.setCursor);
  const cursorToSelection = useEditorStore((state) => state.cursorToSelection);
  const cursorToSelectionOrigin = useEditorStore((state) => state.cursorToSelectionOrigin);
  const selectionToCursor = useEditorStore((state) => state.selectionToCursor);
  const cursorVisible = useEditorStore((state) => state.overlays.cursor);
  const setOverlay = useEditorStore((state) => state.setOverlay);

  if (!menu) return null;

  const snap = (
    id: string,
    label: string,
    target: Vec3 | null,
    available: string,
    missing: string,
  ): ContextMenuEntry => ({
    id,
    label,
    disabled: target === null,
    hint: target ? available : missing,
    onSelect: () => {
      if (target) setCursor(target, label);
    },
  });

  const entries: ContextMenuEntry[] = [
    snap(
      'point',
      'PLACE CURSOR HERE',
      menu.targets.point,
      'Put the cursor exactly where you clicked',
      'Nothing under the pointer to place the cursor on',
    ),
    snap(
      'vertex',
      'CURSOR TO VERTEX',
      menu.targets.vertex,
      'Snap the cursor onto the vertex under the pointer',
      'No vertex close enough to the pointer',
    ),
    snap(
      'edge',
      'CURSOR TO EDGE CENTRE',
      menu.targets.edge,
      'Snap the cursor to the midpoint of the edge under the pointer',
      'No edge close enough to the pointer',
    ),
    snap(
      'face',
      'CURSOR TO FACE CENTRE',
      menu.targets.face,
      'Snap the cursor to the centre of the face under the pointer',
      'No face under the pointer',
    ),
    { id: 'rule-1', separator: true },
    {
      id: 'cursor-to-selection',
      label: 'CURSOR TO SELECTION',
      hint: `Move the cursor onto the middle of the geometry that is selected${shortcut('cursorToSelection')}`,
      onSelect: cursorToSelection,
    },
    {
      id: 'cursor-to-selection-origin',
      label: 'CURSOR TO SELECTION ORIGIN',
      hint: 'Move the cursor onto the origin instead: the amber square, where the gizmo sits. In edit mode, the origin of the object being edited',
      onSelect: cursorToSelectionOrigin,
    },
    {
      id: 'selection-to-cursor',
      label: 'SELECTION TO CURSOR',
      hint: `Move the selection so it lands on the cursor${shortcut('selectionToCursor')}`,
      onSelect: selectionToCursor,
    },
    { id: 'rule-2', separator: true },
    {
      id: 'world-origin',
      label: 'CURSOR TO WORLD ORIGIN',
      hint: `Send the cursor back to 0, 0, 0${shortcut('cursorToWorldOrigin')}`,
      onSelect: () => setCursor({ x: 0, y: 0, z: 0 }, 'Cursor to world origin'),
    },
    {
      id: 'visibility',
      label: cursorVisible ? 'HIDE CURSOR' : 'SHOW CURSOR',
      // Hiding only drops the overlay: the snap entries above still move the
      // cursor, and the pivot still uses wherever it was left.
      hint: cursorVisible
        ? 'Stop showing the cursor without moving it'
        : 'Shows the cursor in the viewport again',
      onSelect: () => setOverlay({ cursor: !cursorVisible }),
    },
  ];

  return (
    <ContextMenu x={menu.x} y={menu.y} label="CURSOR MENU" entries={entries} onClose={close} />
  );
}
