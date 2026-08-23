import { useState } from 'react';

import { Panel } from '@shared/components';
import { useTooltipTrigger } from '@shared/hooks/useTooltipTrigger';
import { useEditorStore } from '@store/index';
import type { SceneObject } from '@store/types';

import './Outliner.scss';

export function Outliner() {
  const objects = useEditorStore((state) => state.objects);
  const activeObjectId = useEditorStore((state) => state.activeObjectId);
  const selectedObjectIds = useEditorStore((state) => state.selectedObjectIds);
  const setActiveObject = useEditorStore((state) => state.setActiveObject);
  const renameObject = useEditorStore((state) => state.renameObject);
  const toggleVisibility = useEditorStore((state) => state.toggleObjectVisibility);
  const toggleLock = useEditorStore((state) => state.toggleObjectLock);

  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <Panel title="OUTLINER" className="outliner">
      {objects.length === 0 ? (
        <p className="outliner__empty">No objects. Add a primitive to begin.</p>
      ) : (
        <ul className="outliner__list">
          {objects.map((object) => (
            <OutlinerRow
              key={object.id}
              object={object}
              isActive={object.id === activeObjectId}
              isSelected={selectedObjectIds.includes(object.id)}
              isEditing={editingId === object.id}
              onSelect={(additive) => setActiveObject(object.id, additive)}
              onStartRename={() => setEditingId(object.id)}
              onFinishRename={(name) => {
                renameObject(object.id, name);
                setEditingId(null);
              }}
              onCancelRename={() => setEditingId(null)}
              onToggleVisibility={() => toggleVisibility(object.id)}
              onToggleLock={() => toggleLock(object.id)}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface OutlinerRowProps {
  object: SceneObject;
  isActive: boolean;
  isSelected: boolean;
  isEditing: boolean;
  onSelect: (additive: boolean) => void;
  onStartRename: () => void;
  onFinishRename: (name: string) => void;
  onCancelRename: () => void;
  onToggleVisibility: () => void;
  onToggleLock: () => void;
}

function OutlinerRow({
  object,
  isActive,
  isSelected,
  isEditing,
  onSelect,
  onStartRename,
  onFinishRename,
  onCancelRename,
  onToggleVisibility,
  onToggleLock,
}: OutlinerRowProps) {
  const nameTooltip = useTooltipTrigger(
    'Click to select, Shift+click to add to selection, double-click to rename',
  );
  const visibilityTooltip = useTooltipTrigger(
    object.visible ? 'Hide this object in the viewport' : 'Show this object in the viewport',
  );
  const lockTooltip = useTooltipTrigger(
    object.locked ? 'Unlock to allow editing again' : 'Lock to prevent accidental edits',
  );

  return (
    <li
      className={[
        'outliner__row',
        isSelected ? 'outliner__row--selected' : '',
        isActive ? 'outliner__row--active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {isEditing ? (
        <input
          className="outliner__rename"
          defaultValue={object.name}
          autoFocus
          onBlur={(event) => onFinishRename(event.target.value.trim() || object.name)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') onCancelRename();
          }}
        />
      ) : (
        <button
          type="button"
          className="outliner__name"
          aria-current={isActive ? 'true' : undefined}
          onClick={(event) => onSelect(event.shiftKey)}
          onDoubleClick={onStartRename}
          {...nameTooltip}
        >
          {object.name}
        </button>
      )}

      <button
        type="button"
        className="outliner__icon"
        aria-label={`${object.visible ? 'Hide' : 'Show'} ${object.name}`}
        aria-pressed={!object.visible}
        onClick={onToggleVisibility}
        {...visibilityTooltip}
      >
        {object.visible ? '◉' : '◌'}
      </button>
      <button
        type="button"
        className="outliner__icon"
        aria-label={`${object.locked ? 'Unlock' : 'Lock'} ${object.name}`}
        aria-pressed={object.locked}
        onClick={onToggleLock}
        {...lockTooltip}
      >
        {object.locked ? '▣' : '▢'}
      </button>
    </li>
  );
}
