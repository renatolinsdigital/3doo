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
      'PLACE HERE',
      menu.targets.point,
      'Put the cursor exactly where you clicked',
      'Nothing under the pointer to place the cursor on',
    ),
    snap(
      'vertex',
      'TO VERTEX',
      menu.targets.vertex,
      'Snap the cursor onto the vertex under the pointer',
      'No vertex close enough to the pointer',
    ),
    snap(
      'edge',
      'TO EDGE CENTRE',
      menu.targets.edge,
      'Snap the cursor to the midpoint of the edge under the pointer',
      'No edge close enough to the pointer',
    ),
    snap(
      'face',
      'TO FACE CENTRE',
      menu.targets.face,
      'Snap the cursor to the centre of the face under the pointer',
      'No face under the pointer',
    ),
    { id: 'rule-1', separator: true },
    {
      id: 'cursor-to-selection',
      label: 'TO SELECTION',
      hint: 'Move the cursor onto the middle of what is selected',
      onSelect: cursorToSelection,
    },
    {
      id: 'selection-to-cursor',
      label: 'SELECTION HERE',
      hint: 'Move the selection so it lands on the cursor',
      onSelect: selectionToCursor,
    },
    { id: 'rule-2', separator: true },
    {
      id: 'world-origin',
      label: 'TO WORLD ORIGIN',
      hint: 'Send the cursor back to 0, 0, 0',
      onSelect: () => setCursor({ x: 0, y: 0, z: 0 }, 'Cursor to world origin'),
    },
  ];

  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      label="3D CURSOR"
      entries={entries}
      onClose={close}
    />
  );
}
