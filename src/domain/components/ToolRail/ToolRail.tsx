import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';

import { type ContextMenuEntry, ContextMenu, IconButton } from '@shared/components';
import { SELECT_SHAPES, useEditorStore } from '@store/index';
import type { SelectShape, ToolId } from '@store/types';

import './ToolRail.scss';

interface ToolEntry {
  id: ToolId;
  icon: ReactNode;
  label: string;
  shortcut: string;
  hint: string;
  /**
   * For a tool that only works on mesh elements: what it says in object mode,
   * where it stays in the rail, greyed out, rather than the rail changing shape.
   */
  objectHint?: string;
}

/**
 * The knife, drawn rather than typed: no character set has one that renders as
 * plain text everywhere. The blade and handle are the ones the pointer wears
 * while the tool is in hand.
 */
const KNIFE_ICON = (
  <svg className="tool-rail__icon" viewBox="2 7 24 24" aria-hidden="true">
    <path d="M3 29L10.9 16.4L15.7 21.2Q11.5 26.9 3 29Z" fill="currentColor" />
    <path
      d="M14 18L20.7 11.3"
      fill="none"
      stroke="currentColor"
      strokeWidth="4.2"
      strokeLinecap="round"
    />
  </svg>
);

/** What the select tool wears, and what its menu says, per region shape. */
const SHAPE_FACES: Record<SelectShape, { icon: string; label: string; hint: string }> = {
  box: {
    icon: '⬚',
    label: 'SQUARE',
    hint: 'Drag a rectangle over what you want selected (V)',
  },
  circle: {
    icon: '◯',
    label: 'CIRCLE',
    hint: 'Drag an oval out from its centre over what you want selected, Shift to keep it round (V)',
  },
  lasso: {
    icon: '✎',
    label: 'LASSO',
    hint: 'Draw a freehand loop around what you want selected (V)',
  },
};

const TOOLS: ToolEntry[] = [
  {
    id: 'select',
    icon: '⬚',
    label: 'Select',
    shortcut: 'V',
    hint: 'Click, drag a region or Alt+click to select geometry. V or another click changes the region shape',
  },
  {
    id: 'move',
    icon: '✥',
    label: 'Move',
    shortcut: 'G',
    hint: 'Drag the gizmo to translate the selection',
  },
  {
    id: 'rotate',
    icon: '↻',
    label: 'Rotate',
    shortcut: 'R',
    hint: 'Drag the gizmo to rotate the selection',
  },
  {
    id: 'scale',
    icon: '⤢',
    label: 'Scale',
    shortcut: 'S',
    hint: 'Drag the gizmo to scale the selection',
  },
  {
    id: 'knife',
    icon: KNIFE_ICON,
    label: 'Knife',
    shortcut: 'K',
    hint: 'Click points on the mesh to cut new edges through its faces. Enter makes the cut, Esc calls it off',
    objectHint: 'The knife cuts the faces of a mesh: enter edit mode first (Tab)',
  },
];

export function ToolRail() {
  const mode = useEditorStore((state) => state.mode);
  const activeTool = useEditorStore((state) => state.activeTool);
  const setActiveTool = useEditorStore((state) => state.setActiveTool);
  const selectShape = useEditorStore((state) => state.selectShape);
  const setSelectShape = useEditorStore((state) => state.setSelectShape);
  const originToGeometry = useEditorStore((state) => state.originToGeometry);

  const [shapeMenu, setShapeMenu] = useState<{ x: number; y: number } | null>(null);

  const shapeEntries: ContextMenuEntry[] = SELECT_SHAPES.map((shape) => ({
    id: shape,
    label: SHAPE_FACES[shape].label,
    hint: SHAPE_FACES[shape].hint,
    current: shape === selectShape,
    onSelect: () => setSelectShape(shape),
  }));

  return (
    <nav className="tool-rail" aria-label="Tool rail">
      {TOOLS.map((tool) => {
        const unavailable = tool.objectHint !== undefined && mode !== 'edit';
        return (
          <IconButton
            key={tool.id}
            // The select button wears the shape it would draw, so the rail says
            // what a drag is about to do without opening anything.
            icon={tool.id === 'select' ? SHAPE_FACES[selectShape].icon : tool.icon}
            label={tool.label}
            shortcut={tool.shortcut}
            hint={unavailable ? tool.objectHint : tool.hint}
            active={activeTool === tool.id}
            disabled={unavailable}
            onClick={(event) => {
              setActiveTool(tool.id);
              if (tool.id === 'select') {
                const rect = event.currentTarget.getBoundingClientRect();
                setShapeMenu({ x: rect.right + 4, y: rect.top });
              }
            }}
          />
        );
      })}
      {/* Below the rule because it is a command, not a tool: it runs once and
          leaves whatever tool you were holding in your hand. */}
      <hr className="tool-rail__rule" />
      <IconButton
        icon="⊙"
        label="Origin to geometry"
        hint="Move each selected object's origin onto the middle of its mesh, bringing the gizmo and the origin marker back onto the shape after an edit-mode move left them behind"
        onClick={() => originToGeometry()}
      />
      {shapeMenu
        ? // Portalled clear of the rail, which is a narrow column the menu
          // would otherwise be cut off by.
          createPortal(
            <ContextMenu
              x={shapeMenu.x}
              y={shapeMenu.y}
              label="SELECT SHAPE"
              entries={shapeEntries}
              onClose={() => setShapeMenu(null)}
            />,
            document.body,
          )
        : null}
    </nav>
  );
}
