import { IconButton } from '@shared/components';
import { useEditorStore } from '@store/index';
import type { ToolId } from '@store/types';

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

const TOOLS: ToolEntry[] = [
  {
    id: 'select',
    icon: '⬚',
    label: 'Select',
    shortcut: 'Esc',
    hint: 'Click, box-select or Alt+click to select geometry',
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
  const exec = useEditorStore((state) => state.exec);

  return (
    <nav className="tool-rail" aria-label="Tools">
      {TOOLS.map((tool) => {
        const disabled = tool.editOnly && mode !== 'edit';
        return (
          <IconButton
            key={tool.id}
            icon={tool.icon}
            label={tool.label}
            shortcut={tool.shortcut}
            hint={tool.hint}
            active={activeTool === tool.id}
            disabled={disabled}
            onClick={() => {
              setActiveTool(tool.id);
              if (tool.operator) exec(tool.operator.name, tool.operator.params, tool.label);
            }}
          />
        );
      })}
    </nav>
  );
}
