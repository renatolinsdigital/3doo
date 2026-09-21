import { useState } from 'react';
import { createPortal } from 'react-dom';

import { type ContextMenuEntry, ContextMenu, IconButton } from '@shared/components';
import { SELECT_SHAPES, useEditorStore } from '@store/index';
import type { SelectShape, ToolId } from '@store/types';

import './ToolRail.scss';

interface ToolEntry {
  id: ToolId;
  icon: string;
  label: string;
  shortcut: string;
  hint: string;
}

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
];

export function ToolRail() {
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
      {TOOLS.map((tool) => (
        <IconButton
          key={tool.id}
          // The select button wears the shape it would draw, so the rail says
          // what a drag is about to do without opening anything.
          icon={tool.id === 'select' ? SHAPE_FACES[selectShape].icon : tool.icon}
          label={tool.label}
          shortcut={tool.shortcut}
          hint={tool.hint}
          active={activeTool === tool.id}
          onClick={(event) => {
            setActiveTool(tool.id);
            if (tool.id === 'select') {
              const rect = event.currentTarget.getBoundingClientRect();
              setShapeMenu({ x: rect.right + 4, y: rect.top });
            }
          }}
        />
      ))}
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
