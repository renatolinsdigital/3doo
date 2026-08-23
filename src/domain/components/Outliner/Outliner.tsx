import { useState } from 'react';

import { Panel } from '@shared/components';
import { useEditorStore } from '@store/index';

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
          {objects.map((object) => {
            const isActive = object.id === activeObjectId;
            const isSelected = selectedObjectIds.includes(object.id);

            return (
              <li
                key={object.id}
                className={[
                  'outliner__row',
                  isSelected ? 'outliner__row--selected' : '',
                  isActive ? 'outliner__row--active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {editingId === object.id ? (
                  <input
                    className="outliner__rename"
                    defaultValue={object.name}
                    autoFocus
                    onBlur={(event) => {
                      renameObject(object.id, event.target.value.trim() || object.name);
                      setEditingId(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="outliner__name"
                    aria-current={isActive ? 'true' : undefined}
                    onClick={(event) => setActiveObject(object.id, event.shiftKey)}
                    onDoubleClick={() => setEditingId(object.id)}
                  >
                    {object.name}
                  </button>
                )}

                <button
                  type="button"
                  className="outliner__icon"
                  aria-label={`${object.visible ? 'Hide' : 'Show'} ${object.name}`}
                  aria-pressed={!object.visible}
                  onClick={() => toggleVisibility(object.id)}
                >
                  {object.visible ? '◉' : '◌'}
                </button>
                <button
                  type="button"
                  className="outliner__icon"
                  aria-label={`${object.locked ? 'Unlock' : 'Lock'} ${object.name}`}
                  aria-pressed={object.locked}
                  onClick={() => toggleLock(object.id)}
                >
                  {object.locked ? '▣' : '▢'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
