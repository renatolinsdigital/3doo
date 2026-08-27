import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { type ContextMenuEntry, ContextMenu, Panel, TextField } from '@shared/components';
import { useTooltipTrigger } from '@shared/hooks/useTooltipTrigger';
import { cx } from '@shared/utils/cx';
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
  const deselectObject = useEditorStore((state) => state.deselectObject);
  const deleteObjects = useEditorStore((state) => state.deleteSelected);
  const applyTransform = useEditorStore((state) => state.applyTransformToSelected);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ objectId: string; x: number; y: number } | null>(null);

  const menuObject = menu ? (objects.find((object) => object.id === menu.objectId) ?? null) : null;

  // Every entry names the row the menu was opened on rather than the selection,
  // which is what the menu's header says and what right-clicking one row of
  // several selected ones reads as.
  const menuEntries = (object: SceneObject): ContextMenuEntry[] => [
    // One entry either way: what a selected row offers is the way back out of
    // the selection, which is the only thing selecting it again could mean.
    selectedObjectIds.includes(object.id)
      ? {
          id: 'select',
          label: 'DESELECT',
          hint: 'Drop this object from the selection, leaving the rest of it alone',
          onSelect: () => deselectObject(object.id),
        }
      : {
          id: 'select',
          label: 'SELECT',
          hint: 'Make this the active object, dropping anything else selected',
          onSelect: () => setActiveObject(object.id, false),
        },
    {
      id: 'rename',
      label: 'RENAME',
      hint: 'Edit the name in place (double-click it)',
      onSelect: () => setEditingId(object.id),
    },
    { id: 'rule', separator: true },
    {
      id: 'apply-transform',
      label: 'APPLY TRANSFORMS',
      disabled: object.locked,
      hint: object.locked
        ? 'Locked objects cannot be edited — unlock it first'
        : 'Bake rotation and scale into the mesh so modifiers and exports see the real shape (Ctrl+A)',
      onSelect: () => applyTransform([object.id]),
    },
    {
      id: 'delete',
      label: 'DELETE',
      hint: 'Remove this object from the scene (X)',
      onSelect: () => deleteObjects([object.id]),
    },
  ];

  // Linked objects are one mesh behind several rows, which is otherwise
  // indistinguishable from a plain copy: the count is what says so.
  const meshUsers = new Map<SceneObject['mesh'], number>();
  for (const object of objects) meshUsers.set(object.mesh, (meshUsers.get(object.mesh) ?? 0) + 1);

  return (
    <Panel title="OUTLINER" className="outliner" scrollable>
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
              onOpenMenu={(x, y) => setMenu({ objectId: object.id, x, y })}
            />
          ))}
        </ul>
      )}
      {menu && menuObject
        ? // Portalled out of the panel: its body scrolls and clips, so a menu
          // drawn inside it would be cut off at the first row near an edge.
          createPortal(
            <ContextMenu
              x={menu.x}
              y={menu.y}
              label={menuObject.name}
              entries={menuEntries(menuObject)}
              onClose={() => setMenu(null)}
            />,
            document.body,
          )
        : null}
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
  /** Opens the row's menu at the pointer, in client coordinates. */
  onOpenMenu: (x: number, y: number) => void;
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
  onOpenMenu,
}: OutlinerRowProps) {
  const nameTooltip = useTooltipTrigger(
    'Click to select, Shift+click to add to selection, double-click to rename, right-click for more',
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
      className={cx(
        'outliner__row',
        isSelected && 'outliner__row--selected',
        isActive && 'outliner__row--active',
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(event.clientX, event.clientY);
      }}
    >
      {isEditing ? (
        <TextField
          label={`Rename ${object.name}`}
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
        className={cx('outliner__icon', !object.visible && 'outliner__icon--on')}
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
        className={cx(
          'outliner__icon',
          object.locked && 'outliner__icon--on',
          trembleToken !== null && 'outliner__icon--tremble',
        )}
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
