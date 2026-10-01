import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { type ContextMenuEntry, ContextMenu, Panel, RenameField } from '@shared/components';
import { useTooltipTrigger } from '@shared/hooks/useTooltipTrigger';
import { cx } from '@shared/utils/cx';
import { useEditorStore } from '@store/index';
import type { MoveTarget, SceneGroup, SceneObject, SelectIntent } from '@store/types';

import './Outliner.scss';

/** Must match the total run time of `.outliner__icon--tremble` in the stylesheet. */
const TREMBLE_MS = 1000;

/** Which kind of row a menu or a rename was opened on. */
type RowRef = { kind: 'object' | 'group'; id: string };

/** How far the pointer travels before a press on a row counts as a drag. */
const DRAG_SLOP = 4;

/**
 * Keeps a press of the pointer from taking focus, and with it the focus ring.
 *
 * Shift+click and Ctrl+click are how a selection of several is built, and
 * holding a modifier key puts the browser in keyboard mode: the row it lands
 * on then rings itself as though the keyboard had reached it, and the ring
 * blinks away again as the row turns selected. Tab goes through no press, so
 * keyboard focus still rings.
 */
function keepFocusOffPointer(event: ReactMouseEvent<HTMLElement>) {
  event.preventDefault();
}

/**
 * Where the row under the pointer would put what is being dragged.
 *
 * Read off the element the pointer is over rather than off React state: a drag
 * is tracked on the window, so the row it is over is whatever the event came
 * through. Null means the pointer is nowhere that takes the row, and the drag
 * leaves it where it was.
 */
function targetUnder(event: PointerEvent, dragged: string): MoveTarget | null {
  const under = event.target instanceof Element ? event.target : null;

  const row = under?.closest<HTMLElement>('[data-object-row]');
  if (row) {
    const objectId = row.dataset.objectRow;
    if (!objectId || objectId === dragged) return null;
    const rect = row.getBoundingClientRect();
    return { kind: 'object', objectId, after: event.clientY > rect.top + rect.height / 2 };
  }

  const groupId = under?.closest<HTMLElement>('[data-group-row]')?.dataset.groupRow;
  return groupId ? { kind: 'group', groupId } : null;
}

export function Outliner() {
  const objects = useEditorStore((state) => state.objects);
  const groups = useEditorStore((state) => state.groups);
  const activeObjectId = useEditorStore((state) => state.activeObjectId);
  const selectedObjectIds = useEditorStore((state) => state.selectedObjectIds);
  const lockedAttempt = useEditorStore((state) => state.lockedAttempt);
  const setActiveObject = useEditorStore((state) => state.setActiveObject);
  const renameObject = useEditorStore((state) => state.renameObject);
  const toggleVisibility = useEditorStore((state) => state.toggleObjectVisibility);
  const toggleLock = useEditorStore((state) => state.toggleObjectLock);
  const deselectObject = useEditorStore((state) => state.deselectObject);
  const selectObjects = useEditorStore((state) => state.selectObjects);
  const deleteObjects = useEditorStore((state) => state.deleteSelected);
  const applyTransform = useEditorStore((state) => state.applyTransformToSelected);
  const renameGroup = useEditorStore((state) => state.renameGroup);
  const selectGroup = useEditorStore((state) => state.selectGroup);
  const deleteGroup = useEditorStore((state) => state.deleteGroup);
  const joinGroup = useEditorStore((state) => state.joinGroup);
  const ungroup = useEditorStore((state) => state.ungroup);
  const removeFromGroup = useEditorStore((state) => state.removeFromGroup);
  const groupSelected = useEditorStore((state) => state.groupSelected);
  const toggleGroupVisibility = useEditorStore((state) => state.toggleGroupVisibility);
  const toggleGroupLock = useEditorStore((state) => state.toggleGroupLock);
  const toggleGroupCollapsed = useEditorStore((state) => state.toggleGroupCollapsed);
  const moveObject = useEditorStore((state) => state.moveObject);

  const [editing, setEditing] = useState<RowRef | null>(null);
  const [menu, setMenu] = useState<(RowRef & { x: number; y: number }) | null>(null);
  /** The object being dragged, and where it would land if it were dropped now. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [landing, setLanding] = useState<MoveTarget | null>(null);

  // Rows are dragged with the pointer rather than with the browser's own drag
  // and drop, which paints a stop sign over everything that takes no drop. The
  // move is the outliner's to make or to leave alone, and it says so with the
  // marks on the rows themselves.
  const startDrag = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    const origin = { x: event.clientX, y: event.clientY };
    let dragged = false;

    const track = (event: PointerEvent) => {
      // A press that never travels is a click on the row, not a drag of it.
      if (!dragged) {
        if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_SLOP) return;
        dragged = true;
        setDragging(id);
      }
      setLanding(targetUnder(event, id));
    };

    const stop = () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', stop);
      setDragging(null);
      setLanding(null);
    };

    const finish = (event: PointerEvent) => {
      const target = dragged ? targetUnder(event, id) : null;
      stop();
      if (!target) return;

      moveObject(id, target);
      if (target.kind === 'group') {
        // A folded folder would swallow the row on its way in, leaving the
        // move nothing to show for itself.
        const folder = groups.find((entry) => entry.id === target.groupId);
        if (folder?.collapsed) toggleGroupCollapsed(folder.id);
      }
    };

    window.addEventListener('pointermove', track);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', stop);
  };

  const members = (group: SceneGroup) => objects.filter((object) => object.groupId === group.id);
  const loose = objects.filter((object) => !groups.some((group) => group.id === object.groupId));

  /**
   * The order the rows read down the panel: each folder's objects under its
   * title, then the loose ones. A folded folder keeps its objects out of it,
   * since a run of rows cannot span rows that are not on screen.
   */
  const rowOrder = [
    ...groups.flatMap((group) =>
      group.collapsed ? [] : members(group).map((object) => object.id),
    ),
    ...loose.map((object) => object.id),
  ];

  /**
   * Answers a click on an object row.
   *
   * A ranged click is Shift's, and works the whole run from the active row to
   * this one, the way a list of files does: in if the row clicked was outside
   * the selection, out if it was in it. Ctrl works the one row clicked and the
   * same way round. The run is named from the active row outwards, so the row
   * clicked is the last one named and the one left active.
   */
  const selectRow = (id: string, intent: SelectIntent, ranged: boolean) => {
    const from = ranged && activeObjectId ? rowOrder.indexOf(activeObjectId) : -1;
    const to = rowOrder.indexOf(id);
    if (from === -1 || to === -1) {
      setActiveObject(id, intent);
      return;
    }

    const run = rowOrder.slice(Math.min(from, to), Math.max(from, to) + 1);
    selectObjects(from <= to ? run : run.reverse(), intent);
  };

  const menuObject =
    menu?.kind === 'object' ? (objects.find((object) => object.id === menu.id) ?? null) : null;
  const menuGroup =
    menu?.kind === 'group' ? (groups.find((group) => group.id === menu.id) ?? null) : null;

  // Every entry names the row the menu was opened on rather than the selection,
  // which is what the menu's header says and what right-clicking one row of
  // several selected ones reads as. GROUP is the exception, since a folder of
  // one object is not worth making: its hint names the selection instead.
  const objectEntries = (object: SceneObject): ContextMenuEntry[] => {
    const selection = objects.filter((candidate) => selectedObjectIds.includes(candidate.id));
    const grouped = selection.filter((candidate) =>
      groups.some((group) => group.id === candidate.groupId),
    );
    const groupable = selection.length > 1 && grouped.length === 0;

    return [
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
            onSelect: () => setActiveObject(object.id),
          },
      {
        id: 'rename',
        label: 'RENAME',
        hint: 'Edit the name in place (double-click it)',
        onSelect: () => setEditing({ kind: 'object', id: object.id }),
      },
      {
        id: 'group',
        label: 'GROUP',
        disabled: !groupable,
        hint: groupable
          ? `Put the ${selection.length} selected objects in a folder of their own (Ctrl+G)`
          : selection.length < 2
            ? 'Grouping needs two objects selected at least'
            : 'Every object selected has to be loose, so take the grouped ones out of their folders first',
        onSelect: () => groupSelected(),
      },
      ...(groups.some((group) => group.id === object.groupId)
        ? [
            {
              id: 'remove-from-group',
              label: 'REMOVE FROM GROUP',
              hint: 'Take this object out of its folder and leave it loose in the scene',
              onSelect: () => removeFromGroup(object.id),
            },
          ]
        : []),
      { id: 'rule', separator: true },
      {
        id: 'apply-transform',
        label: 'APPLY TRANSFORMS',
        disabled: object.locked,
        hint: object.locked
          ? 'Locked objects cannot be edited, so unlock it first'
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
  };

  const groupEntries = (group: SceneGroup): ContextMenuEntry[] => {
    const held = members(group);
    const joinable = held.filter((object) => !object.locked).length >= 2;

    return [
      {
        id: 'rename',
        label: 'RENAME',
        hint: 'Edit the folder name in place (double-click it)',
        onSelect: () => setEditing({ kind: 'group', id: group.id }),
      },
      {
        id: 'select',
        label: 'SELECT ALL',
        hint: 'Select every object in this folder, dropping anything else selected',
        onSelect: () => selectGroup(group.id),
      },
      { id: 'rule', separator: true },
      {
        id: 'join',
        label: 'JOIN',
        disabled: !joinable,
        hint: joinable
          ? 'Fold every object in here into one, sharing a single mesh'
          : 'Joining needs two unlocked objects at least, so unlock them first',
        onSelect: () => joinGroup(group.id),
      },
      {
        id: 'ungroup',
        label: 'UNGROUP',
        hint: 'Drop the folder and leave its objects loose in the scene',
        onSelect: () => ungroup(group.id),
      },
      {
        id: 'delete',
        label: 'DELETE',
        hint: `Remove the folder and all ${held.length} of its objects from the scene`,
        onSelect: () => deleteGroup(group.id),
      },
    ];
  };

  // Linked objects are one mesh behind several rows, which is otherwise
  // indistinguishable from a plain copy: the count is what says so.
  const meshUsers = new Map<SceneObject['mesh'], number>();
  for (const object of objects) meshUsers.set(object.mesh, (meshUsers.get(object.mesh) ?? 0) + 1);

  const renderObject = (object: SceneObject) => (
    <OutlinerRow
      key={object.id}
      object={object}
      meshUsers={meshUsers.get(object.mesh) ?? 1}
      isActive={object.id === activeObjectId}
      isSelected={selectedObjectIds.includes(object.id)}
      isEditing={editing?.kind === 'object' && editing.id === object.id}
      isDragging={dragging === object.id}
      landingEdge={
        landing?.kind === 'object' && landing.objectId === object.id
          ? landing.after
            ? 'after'
            : 'before'
          : null
      }
      onDragStart={(event) => startDrag(object.id, event)}
      lockAttemptToken={lockedAttempt?.objectId === object.id ? lockedAttempt.token : null}
      onSelect={(intent, ranged) => selectRow(object.id, intent, ranged)}
      onStartRename={() => setEditing({ kind: 'object', id: object.id })}
      onFinishRename={(name) => {
        renameObject(object.id, name);
        setEditing(null);
      }}
      onCancelRename={() => setEditing(null)}
      onToggleVisibility={() => toggleVisibility(object.id)}
      onToggleLock={() => toggleLock(object.id)}
      onOpenMenu={(x, y) => setMenu({ kind: 'object', id: object.id, x, y })}
    />
  );

  const openMenu = menuObject
    ? { label: menuObject.name, entries: objectEntries(menuObject) }
    : menuGroup
      ? { label: menuGroup.name, entries: groupEntries(menuGroup) }
      : null;

  return (
    <Panel title="OUTLINER" className="outliner" scrollable>
      {objects.length === 0 ? (
        <p className="outliner__empty">No objects. Add a primitive to begin.</p>
      ) : (
        <ul className="outliner__list">
          {groups.map((group) => {
            const held = members(group);
            return (
              <li key={group.id} className="outliner__branch">
                <OutlinerGroupRow
                  group={group}
                  members={held}
                  isSelected={held.every((object) => selectedObjectIds.includes(object.id))}
                  isEditing={editing?.kind === 'group' && editing.id === group.id}
                  isLanding={landing?.kind === 'group' && landing.groupId === group.id}
                  onSelect={() => selectGroup(group.id)}
                  onToggleCollapsed={() => toggleGroupCollapsed(group.id)}
                  onStartRename={() => setEditing({ kind: 'group', id: group.id })}
                  onFinishRename={(name) => {
                    renameGroup(group.id, name);
                    setEditing(null);
                  }}
                  onCancelRename={() => setEditing(null)}
                  onToggleVisibility={() => toggleGroupVisibility(group.id)}
                  onToggleLock={() => toggleGroupLock(group.id)}
                  onOpenMenu={(x, y) => setMenu({ kind: 'group', id: group.id, x, y })}
                />
                {group.collapsed ? null : (
                  <ul className="outliner__list outliner__list--nested">
                    {held.map(renderObject)}
                  </ul>
                )}
              </li>
            );
          })}
          {loose.map(renderObject)}
        </ul>
      )}
      {menu && openMenu
        ? // Portalled out of the panel: its body scrolls and clips, so a menu
          // drawn inside it would be cut off at the first row near an edge.
          createPortal(
            <ContextMenu
              x={menu.x}
              y={menu.y}
              label={openMenu.label}
              entries={openMenu.entries}
              onClose={() => setMenu(null)}
            />,
            document.body,
          )
        : null}
    </Panel>
  );
}

interface OutlinerGroupRowProps {
  group: SceneGroup;
  members: readonly SceneObject[];
  /** Every object in the folder is selected, so the folder reads as selected too. */
  isSelected: boolean;
  isEditing: boolean;
  /** The dragged row would land in this folder if it were let go now. */
  isLanding: boolean;
  onSelect: () => void;
  onToggleCollapsed: () => void;
  onStartRename: () => void;
  onFinishRename: (name: string) => void;
  onCancelRename: () => void;
  onToggleVisibility: () => void;
  onToggleLock: () => void;
  /** Opens the folder's menu at the pointer, in client coordinates. */
  onOpenMenu: (x: number, y: number) => void;
}

function OutlinerGroupRow({
  group,
  members,
  isSelected,
  isEditing,
  isLanding,
  onSelect,
  onToggleCollapsed,
  onStartRename,
  onFinishRename,
  onCancelRename,
  onToggleVisibility,
  onToggleLock,
  onOpenMenu,
}: OutlinerGroupRowProps) {
  // A folder holding one visible object still has something to hide, and one
  // holding a single unlocked object still has something to lock: the toggles
  // only read as on once every row underneath them is.
  const hidden = members.every((object) => !object.visible);
  const locked = members.every((object) => object.locked);

  const nameTooltip = useTooltipTrigger(
    `Click to select the ${members.length} object(s) in here, double-click to rename, drop an object on this title to put it in here, right-click for more`,
  );
  const foldTooltip = useTooltipTrigger(
    group.collapsed ? 'Show what is in this folder' : 'Fold this folder shut',
  );
  const visibilityTooltip = useTooltipTrigger(
    hidden ? 'Show every object in this folder' : 'Hide every object in this folder',
  );
  const lockTooltip = useTooltipTrigger(
    locked ? 'Unlock every object in this folder' : 'Lock every object in this folder',
  );

  return (
    <div
      className={cx(
        'outliner__row',
        'outliner__row--group',
        isSelected && 'outliner__row--selected',
        isLanding && 'outliner__row--landing',
      )}
      data-group-row={group.id}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(event.clientX, event.clientY);
      }}
    >
      <button
        type="button"
        className="outliner__fold"
        aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} ${group.name}`}
        aria-expanded={!group.collapsed}
        onMouseDown={keepFocusOffPointer}
        onClick={onToggleCollapsed}
        {...foldTooltip}
      >
        <ChevronIcon collapsed={group.collapsed} />
      </button>

      {isEditing ? (
        <RenameField name={group.name} onRename={onFinishRename} onCancel={onCancelRename} />
      ) : (
        <button
          type="button"
          className="outliner__name"
          onMouseDown={keepFocusOffPointer}
          onClick={onSelect}
          onDoubleClick={onStartRename}
          {...nameTooltip}
        >
          {group.name}
        </button>
      )}

      <button
        type="button"
        className={cx('outliner__icon', hidden && 'outliner__icon--on')}
        aria-label={`${hidden ? 'Show' : 'Hide'} ${group.name}`}
        aria-pressed={hidden}
        onMouseDown={keepFocusOffPointer}
        onClick={onToggleVisibility}
        {...visibilityTooltip}
      >
        {hidden ? <EyeOffIcon /> : <EyeIcon />}
      </button>
      <button
        type="button"
        className={cx('outliner__icon', locked && 'outliner__icon--on')}
        aria-label={`${locked ? 'Unlock' : 'Lock'} ${group.name}`}
        aria-pressed={locked}
        onMouseDown={keepFocusOffPointer}
        onClick={onToggleLock}
        {...lockTooltip}
      >
        {locked ? <LockIcon /> : <UnlockIcon />}
      </button>
    </div>
  );
}

interface OutlinerRowProps {
  object: SceneObject;
  /** How many objects share this object's mesh, itself included. */
  meshUsers: number;
  isActive: boolean;
  isSelected: boolean;
  isEditing: boolean;
  /** This row is the one being dragged. */
  isDragging: boolean;
  /** The edge the dragged row would land on, or null when it would land elsewhere. */
  landingEdge: 'before' | 'after' | null;
  /** Takes the press that may turn into a drag of this row. */
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Changes each time an edit is denied because this object is locked; drives the lock icon's tremble. */
  lockAttemptToken: number | null;
  /** Ranged asks for the run from the active row to this one, rather than this row alone. */
  onSelect: (intent: SelectIntent, ranged: boolean) => void;
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
  isDragging,
  landingEdge,
  onDragStart,
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
    'Click to select, Shift+click to take the whole run from the active row to this one in or out of the selection, Ctrl+click for this row alone, double-click to rename, drag to reorder or to drop into a folder, right-click for more',
  );
  const visibilityTooltip = useTooltipTrigger(
    object.visible ? 'Hide this object in the viewport' : 'Show this object in the viewport',
  );
  const lockTooltip = useTooltipTrigger(
    object.locked ? 'Unlock to allow editing again' : 'Lock to prevent accidental edits',
  );
  const linkTooltip = useTooltipTrigger(
    meshUsers > 1
      ? `Mesh data shared with ${meshUsers - 1} other object(s): editing one edits them all`
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
        isDragging && 'outliner__row--dragging',
        landingEdge && `outliner__row--landing-${landingEdge}`,
      )}
      data-object-row={object.id}
      onPointerDown={(event) => {
        // The left button only, and never while the row holds a text field.
        // The toggles at its end are controls of their own, not a grip.
        if (event.button !== 0 || isEditing) return;
        if (event.target instanceof Element && event.target.closest('.outliner__icon')) return;
        onDragStart(event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(event.clientX, event.clientY);
      }}
    >
      {isEditing ? (
        <RenameField name={object.name} onRename={onFinishRename} onCancel={onCancelRename} />
      ) : (
        <button
          type="button"
          className="outliner__name"
          aria-current={isActive ? 'true' : undefined}
          onMouseDown={keepFocusOffPointer}
          onClick={(event) => {
            // Which way a modified click pulls is the row's own state: a row
            // outside the selection takes its run in, one already in it drops
            // the run back out.
            const intent = isSelected ? 'subtract' : 'add';
            if (event.ctrlKey || event.metaKey) onSelect(intent, false);
            else if (event.shiftKey) onSelect(intent, true);
            else onSelect('replace', false);
          }}
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
        onMouseDown={keepFocusOffPointer}
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
        onMouseDown={keepFocusOffPointer}
        onClick={onToggleLock}
        {...lockTooltip}
      >
        {object.locked ? <LockIcon /> : <UnlockIcon />}
      </button>
    </li>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className="outliner__glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {collapsed ? <path d="M6 3 11 8 6 13" /> : <path d="M3 6 8 11 13 6" />}
    </svg>
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
