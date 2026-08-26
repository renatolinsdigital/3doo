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
  /** Operator to run on click; transform tools attach the gizmo instead. */
  operator?: { name: string; params: Record<string, unknown> };
  editOnly?: boolean;
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
    hint: 'Drag out from the centre of a circle over what you want selected (V)',
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
    hint: 'Click, drag a region or Alt+click to select geometry — V or another click changes the region shape',
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
    id: 'extrude',
    icon: '⇧',
    label: 'Extrude',
    shortcut: 'E',
    hint: 'Pull the selected faces out along their normal',
    operator: { name: 'extrude', params: { offset: 1 } },
    editOnly: true,
  },
  {
    id: 'inset',
    icon: '⊡',
    label: 'Inset',
    shortcut: 'I',
    hint: 'Shrink the selected faces inward and keep the border',
    operator: { name: 'inset', params: { thickness: 0.2 } },
    editOnly: true,
  },
  {
    id: 'bevel',
    icon: '◣',
    label: 'Bevel',
    shortcut: 'Ctrl+B',
    hint: 'Chamfer the selected edges into a flat or rounded strip',
    operator: { name: 'bevel', params: { width: 0.2, segments: 1 } },
    editOnly: true,
  },
  {
    id: 'loopcut',
    icon: '≡',
    label: 'Loop cut',
    shortcut: 'Ctrl+R',
    hint: 'Insert a new edge loop across a ring of quads',
    operator: { name: 'loopCut', params: { cuts: 1 } },
    editOnly: true,
  },
  {
    id: 'merge',
    icon: '◎',
    label: 'Merge by distance',
    shortcut: 'M',
    hint: 'Weld vertices closer than a threshold together',
    operator: { name: 'mergeByDistance', params: { threshold: 0.001 } },
    editOnly: true,
  },
];

export function ToolRail() {
  const mode = useEditorStore((state) => state.mode);
  const activeTool = useEditorStore((state) => state.activeTool);
  const setActiveTool = useEditorStore((state) => state.setActiveTool);
  const selectShape = useEditorStore((state) => state.selectShape);
  const setSelectShape = useEditorStore((state) => state.setSelectShape);
  const exec = useEditorStore((state) => state.exec);

  const [shapeMenu, setShapeMenu] = useState<{ x: number; y: number } | null>(null);

  const shapeEntries: ContextMenuEntry[] = SELECT_SHAPES.map((shape) => ({
    id: shape,
    label: SHAPE_FACES[shape].label,
    hint: SHAPE_FACES[shape].hint,
    current: shape === selectShape,
    onSelect: () => setSelectShape(shape),
  }));

  return (
    <nav className="tool-rail" aria-label="Tools">
      {TOOLS.map((tool) => {
        const disabled = tool.editOnly && mode !== 'edit';
        return (
          <IconButton
            key={tool.id}
            // The select button wears the shape it would draw, so the rail says
            // what a drag is about to do without opening anything.
            icon={tool.id === 'select' ? SHAPE_FACES[selectShape].icon : tool.icon}
            label={tool.label}
            shortcut={tool.shortcut}
            hint={tool.hint}
            active={activeTool === tool.id}
            disabled={disabled}
            onClick={(event) => {
              setActiveTool(tool.id);
              if (tool.operator) exec(tool.operator.name, tool.operator.params, tool.label);
              if (tool.id === 'select') {
                const rect = event.currentTarget.getBoundingClientRect();
                setShapeMenu({ x: rect.right + 4, y: rect.top });
              }
            }}
          />
        );
      })}
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
