import type { Vec3 } from '@kernel/index';
import { type ContextMenuEntry, ContextMenu } from '@shared/components';
import { useEditorStore } from '@store/index';

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
      'Put the cursor exactly where you clicked (CTRL+SHIFT+C)',
      'Nothing under the pointer to place the cursor on',
    ),
    snap(
      'vertex',
      'CURSOR TO VERTEX',
      menu.targets.vertex,
      'Snap the cursor onto the vertex under the pointer (CTRL+SHIFT+V)',
      'No vertex close enough to the pointer',
    ),
    snap(
      'edge',
      'CURSOR TO EDGE CENTRE',
      menu.targets.edge,
      'Snap the cursor to the midpoint of the edge under the pointer (CTRL+SHIFT+E)',
      'No edge close enough to the pointer',
    ),
    snap(
      'face',
      'CURSOR TO FACE CENTRE',
      menu.targets.face,
      'Snap the cursor to the centre of the face under the pointer (CTRL+SHIFT+F)',
      'No face under the pointer',
    ),
    { id: 'rule-1', separator: true },
    {
      id: 'cursor-to-selection',
      label: 'CURSOR TO SELECTION',
      hint: 'Move the cursor onto the middle of what is selected (CTRL+SHIFT+V)',
      onSelect: cursorToSelection,
    },
    {
      id: 'selection-to-cursor',
      label: 'SELECTION TO CURSOR',
      hint: 'Move the selection so it lands on the cursor (CTRL+SHIFT+S)',
      onSelect: selectionToCursor,
    },
    { id: 'rule-2', separator: true },
    {
      id: 'world-origin',
      label: 'CURSOR TO WORLD ORIGIN',
      hint: 'Send the cursor back to 0, 0, 0 (CTRL+SHIFT+O)',
      onSelect: () => setCursor({ x: 0, y: 0, z: 0 }, 'Cursor to world origin'),
    },
    {
      id: 'visibility',
      label: cursorVisible ? 'HIDE CURSOR' : 'SHOW CURSOR',
      // Hiding only drops the overlay: the snap entries above still move the
      // cursor, and the pivot still uses wherever it was left.
      hint: cursorVisible
        ? 'Stop showing the cursor without moving it (CTRL+SHIFT+H)'
        : 'Shows the cursor in the viewport again (CTRL+SHIFT+H)',
      onSelect: () => setOverlay({ cursor: !cursorVisible }),
    },
  ];

  return (
    <ContextMenu x={menu.x} y={menu.y} label="CURSOR MENU" entries={entries} onClose={close} />
  );
}
