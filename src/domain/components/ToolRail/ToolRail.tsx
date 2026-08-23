import { IconButton } from '@shared/components';
import { useEditorStore } from '@store/index';
import type { ToolId } from '@store/types';

import './ToolRail.scss';

interface ToolEntry {
  id: ToolId;
  icon: string;
  label: string;
  shortcut: string;
  /** Operator to run on click; transform tools attach the gizmo instead. */
  operator?: { name: string; params: Record<string, unknown> };
  editOnly?: boolean;
}

const TOOLS: ToolEntry[] = [
  { id: 'select', icon: '⬚', label: 'Select', shortcut: 'Esc' },
  { id: 'move', icon: '✥', label: 'Move', shortcut: 'G' },
  { id: 'rotate', icon: '↻', label: 'Rotate', shortcut: 'R' },
  { id: 'scale', icon: '⤢', label: 'Scale', shortcut: 'S' },
  {
    id: 'extrude',
    icon: '⇧',
    label: 'Extrude',
    shortcut: 'E',
    operator: { name: 'extrude', params: { offset: 1 } },
    editOnly: true,
  },
  {
    id: 'inset',
    icon: '⊡',
    label: 'Inset',
    shortcut: 'I',
    operator: { name: 'inset', params: { thickness: 0.2 } },
    editOnly: true,
  },
  {
    id: 'bevel',
    icon: '◣',
    label: 'Bevel',
    shortcut: 'Ctrl+B',
    operator: { name: 'bevel', params: { width: 0.2, segments: 1 } },
    editOnly: true,
  },
  {
    id: 'loopcut',
    icon: '≡',
    label: 'Loop cut',
    shortcut: 'Ctrl+R',
    operator: { name: 'loopCut', params: { cuts: 1 } },
    editOnly: true,
  },
  {
    id: 'merge',
    icon: '◎',
    label: 'Merge by distance',
    shortcut: 'M',
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
