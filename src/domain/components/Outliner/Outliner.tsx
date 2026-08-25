import { useEffect, useState } from 'react';

import { Panel } from '@shared/components';
import { useTooltipTrigger } from '@shared/hooks/useTooltipTrigger';
import { useEditorStore } from '@store/index';
import type { SceneObject } from '@store/types';

import './Outliner.scss';

/** Must match the total run time of `.outliner__icon--tremble` in the stylesheet. */
const TREMBLE_MS = 1000;

export function Outliner() {
  const objects = useEditorStore((state) => state.objects);
  const activeObjectId = useEditorStore((state) => state.activeObjectId);
  const selectedObjectIds = useEditorStore((state) => state.selectedObjectIds);
  const lockedAttempt = useEditorStore((state) => state.lockedAttempt);
  const setActiveObject = useEditorStore((state) => state.setActiveObject);
  const renameObject = useEditorStore((state) => state.renameObject);
  const toggleVisibility = useEditorStore((state) => state.toggleObjectVisibility);
  const toggleLock = useEditorStore((state) => state.toggleObjectLock);

  const [editingId, setEditingId] = useState<string | null>(null);

  // Linked objects are one mesh behind several rows, which is otherwise
  // indistinguishable from a plain copy: the count is what says so.
  const meshUsers = new Map<SceneObject['mesh'], number>();
  for (const object of objects) meshUsers.set(object.mesh, (meshUsers.get(object.mesh) ?? 0) + 1);

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
              meshUsers={meshUsers.get(object.mesh) ?? 1}
              isActive={object.id === activeObjectId}
              isSelected={selectedObjectIds.includes(object.id)}
              isEditing={editingId === object.id}
              lockAttemptToken={lockedAttempt?.objectId === object.id ? lockedAttempt.token : null}
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
  /** How many objects share this object's mesh, itself included. */
  meshUsers: number;
  isActive: boolean;
  isSelected: boolean;
  isEditing: boolean;
  /** Changes each time an edit is denied because this object is locked; drives the lock icon's tremble. */
  lockAttemptToken: number | null;
  onSelect: (additive: boolean) => void;
  onStartRename: () => void;
  onFinishRename: (name: string) => void;
  onCancelRename: () => void;
  onToggleVisibility: () => void;
  onToggleLock: () => void;
}

function OutlinerRow({
  object,
  meshUsers,
  isActive,
  isSelected,
  isEditing,
  lockAttemptToken,
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
  const linkTooltip = useTooltipTrigger(
    meshUsers > 1
      ? `Mesh data shared with ${meshUsers - 1} other object(s) — editing one edits them all`
      : undefined,
  );

  const [trembleToken, setTrembleToken] = useState<number | null>(null);

  // Clicking (or failing to edit) this object bumps lockAttemptToken; shake the
  // lock icon in response, rather than for as long as the object stays locked.
  useEffect(() => {
    if (lockAttemptToken === null) return;
    setTrembleToken(lockAttemptToken);
    const timer = window.setTimeout(() => setTrembleToken(null), TREMBLE_MS);
    return () => window.clearTimeout(timer);
  }, [lockAttemptToken]);

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

      {meshUsers > 1 ? (
        <span
          className="outliner__badge"
          aria-label={`Mesh shared with ${meshUsers - 1} other object(s)`}
          {...linkTooltip}
        >
          <LinkIcon />
          {meshUsers}
        </span>
      ) : null}

      <button
        type="button"
        className={`outliner__icon${object.visible ? '' : ' outliner__icon--on'}`}
        aria-label={`${object.visible ? 'Hide' : 'Show'} ${object.name}`}
        aria-pressed={!object.visible}
        onClick={onToggleVisibility}
        {...visibilityTooltip}
      >
        {object.visible ? <EyeIcon /> : <EyeOffIcon />}
      </button>
      <button
        type="button"
        // Keyed on the token so a click during a shake remounts the button and
        // restarts the animation, instead of leaving it frozen mid-run.
        key={trembleToken ?? 'lock'}
        className={[
          'outliner__icon',
          object.locked ? 'outliner__icon--on' : '',
          trembleToken !== null ? 'outliner__icon--tremble' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label={`${object.locked ? 'Unlock' : 'Lock'} ${object.name}`}
        aria-pressed={object.locked}
        onClick={onToggleLock}
        {...lockTooltip}
      >
        {object.locked ? <LockIcon /> : <UnlockIcon />}
      </button>
    </li>
  );
}

function LinkIcon() {
  return (
    <svg
      className="outliner__glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M9.5 4.5 11 3a3 3 0 0 1 4 4l-1.5 1.5" />
      <path d="M6.5 11.5 5 13a3 3 0 0 1-4-4l1.5-1.5" />
      <path d="M5.5 10.5 10.5 5.5" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg
      className="outliner__glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 8C1 8 3.5 3 8 3s7 5 7 5-2.5 5-7 5-7-5-7-5Z" />
      <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      className="outliner__glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M1 8C1 8 3.5 3 8 3s7 5 7 5-2.5 5-7 5-7-5-7-5Z" />
      <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
      <line x1="1.5" y1="1.5" x2="14.5" y2="14.5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      className="outliner__glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" />
      <path d="M5 7V4.5a3 3 0 0 1 6 0V7" />
    </svg>
  );
}

function UnlockIcon() {
  return (
    <svg
      className="outliner__glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" />
      <path d="M5 7V4.5a3 3 0 0 1 6 0" />
    </svg>
  );
}
