import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  Button,
  ContextMenu,
  IconButton,
  NumberField,
  SegmentedControl,
  SegmentedToggle,
  Select,
  TextField,
  type ContextMenuEntry,
} from '@shared/components';
import { cx } from '@shared/utils/cx';
import {
  MAX_SNAP_STEP,
  MIN_SNAP_STEP,
  useActiveObject,
  useActiveShadingSmooth,
  useEditorStore,
} from '@store/index';
import type { EditorMode, OverlaySettings, PivotMode, ShadingMode, SnapMode } from '@store/types';

import { useProjectFiles } from '../../hooks/useProjectFiles';

import './TopBar.scss';

const MODE_OPTIONS = [
  { value: 'object', label: 'OBJECT', shortcut: 'Tab' },
  { value: 'edit', label: 'EDIT', shortcut: 'Tab' },
] as const;

// Spelled out rather than abbreviated: a menu has the room a five-segment
// control inside a 260px panel did not.
const SHADING_OPTIONS: readonly { value: ShadingMode; label: string; hint: string }[] = [
  { value: 'solid', label: 'SOLID', hint: 'Flat-lit solid surfaces, no edges' },
  {
    value: 'solidWire',
    label: 'SOLID + WIRE',
    hint: 'Solid surfaces with the wireframe over them',
  },
  { value: 'wireframe', label: 'WIREFRAME', hint: 'Edges only, no filled surfaces' },
  {
    value: 'xray',
    label: 'X-RAY',
    hint: 'See-through surfaces, so box-select reaches what is behind',
  },
  { value: 'matcap', label: 'MATCAP', hint: 'Flat, high-contrast shading that reads form' },
];

const SNAP_OPTIONS: readonly { value: SnapMode; label: string }[] = [
  { value: 'grid', label: 'GRID' },
  { value: 'custom', label: 'CUSTOM' },
];

const PIVOT_OPTIONS: readonly { value: PivotMode; label: string }[] = [
  { value: 'origin', label: 'ORIGIN' },
  { value: 'median', label: 'MEDIAN' },
  { value: 'cursor', label: 'CURSOR' },
];

const OVERLAY_OPTIONS: readonly { key: keyof OverlaySettings; label: string; hint: string }[] = [
  {
    key: 'grid',
    label: 'GRID',
    hint: 'The ground grid: 1 m squares at normal zoom, rescaled by ten as you pull back',
  },
  { key: 'axes', label: 'AXES', hint: 'The coloured X/Z axis lines' },
  {
    key: 'cursor',
    label: '3D CURSOR',
    hint: 'The 3D cursor ring in the viewport: hiding it does not move it',
  },
  {
    key: 'origins',
    label: 'ORIGINS',
    hint: 'A small square on the origin of every selected object, what a rotation turns about on the ORIGIN pivot, drawn over the geometry it is inside',
  },
  { key: 'normals', label: 'NORMALS', hint: 'A short line out of every face along its normal' },
  {
    key: 'faceOrientation',
    label: 'FACE ORIENT',
    hint: 'Backfaces tinted red, so inverted normals are obvious',
  },
  {
    key: 'statistics',
    label: 'STATISTICS',
    hint: 'Vertex, edge, face and triangle counts in the status bar',
  },
];

export interface TopBarProps {
  /**
   * The brand plate, passed in rather than imported.
   *
   * The switcher belongs to the app shell, which sits above this layer, and
   * dependencies here point inward, never back up at it.
   */
  brand: ReactNode;
}

export function TopBar({ brand }: TopBarProps) {
  const mode = useEditorStore((state) => state.mode);
  const setMode = useEditorStore((state) => state.setMode);
  const projectName = useEditorStore((state) => state.projectName);
  const undoSteps = useEditorStore((state) => state.historyUndo.length);
  const setProjectName = useEditorStore((state) => state.setProjectName);
  const openDialog = useEditorStore((state) => state.openDialog);
  // Snapping is a preference, so this bar and the preferences dialog are two
  // views of one setting rather than two settings that have to be kept in step.
  const snapEnabled = useEditorStore((state) => state.snapEnabled);
  const snapMode = useEditorStore((state) => state.snapMode);
  const snapStep = useEditorStore((state) => state.snapStep);
  const setPreferences = useEditorStore((state) => state.setPreferences);
  const proportional = useEditorStore((state) => state.proportional);
  const setProportional = useEditorStore((state) => state.setProportional);
  const autoMerge = useEditorStore((state) => state.autoMerge);
  const setAutoMerge = useEditorStore((state) => state.setAutoMerge);
  const orthographic = useEditorStore((state) => state.orthographic);
  const activeObject = useActiveObject();
  const smoothShaded = useActiveShadingSmooth();
  const exec = useEditorStore((state) => state.exec);
  const setViewportSetting = useEditorStore((state) => state.setViewportSetting);
  const shading = useEditorStore((state) => state.shading);
  const setShading = useEditorStore((state) => state.setShading);
  const overlays = useEditorStore((state) => state.overlays);
  const setOverlay = useEditorStore((state) => state.setOverlay);
  const pivot = useEditorStore((state) => state.pivot);
  const setPivot = useEditorStore((state) => state.setPivot);
  const frameSelected = useEditorStore((state) => state.frameSelected);
  const frameAll = useEditorStore((state) => state.frameAll);
  const viewLost = useEditorStore((state) => state.viewLost);

  const { newProject, saveProject, openProject, importMesh } = useProjectFiles();

  const snapHint =
    snapMode === 'grid'
      ? 'Snap: a move, a turn and a scale land on the grid instead of wherever the pointer left them'
      : `Snap: a move, a turn and a scale land on steps of ${snapStep} of the grid square set in preferences, instead of wherever the pointer left them`;

  const shadingLabel = SHADING_OPTIONS.find((option) => option.value === shading)?.label ?? 'SOLID';
  const shadingEntries: ContextMenuEntry[] = SHADING_OPTIONS.map((option) => ({
    id: option.value,
    label: option.label,
    hint: option.hint,
    current: option.value === shading,
    onSelect: () => setShading(option.value),
  }));

  const overlayEntries: ContextMenuEntry[] = OVERLAY_OPTIONS.map((option) => ({
    id: option.key,
    label: option.label,
    hint: option.hint,
    checked: overlays[option.key],
    onToggle: (checked) => setOverlay({ [option.key]: checked }),
  }));

  const fileEntries: ContextMenuEntry[] = [
    {
      id: 'new',
      label: 'NEW',
      hint: 'Start a blank project, discarding unsaved changes',
      onSelect: newProject,
    },
    {
      id: 'open',
      label: 'OPEN',
      hint: 'Load a .3doo project file from disk',
      onSelect: () => void openProject(),
    },
    {
      id: 'save',
      label: 'SAVE',
      hint: 'Save the current project as a .3doo file',
      onSelect: () => void saveProject(),
    },
    { id: 'rule-1', separator: true },
    {
      id: 'import',
      label: 'IMPORT',
      hint: 'Import geometry from an OBJ file as a new object',
      onSelect: () => void importMesh(),
    },
    {
      id: 'export',
      label: 'EXPORT',
      hint: 'Export the scene as OBJ or ASCII FBX (Ctrl+E)',
      onSelect: () => openDialog('export'),
    },
  ];

  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        {brand}
        <TopBarMenu
          label="FILE"
          menuLabel="FILE"
          hint="Project files: new, open, save, import and export"
          entries={fileEntries}
        />
        <Button
          label="PREFS"
          variant="ghost"
          hint="Preferences, including turning hint tooltips on or off"
          onClick={() => openDialog('preferences')}
        />
        <TextField
          label="Project name"
          className="top-bar__project-input"
          value={projectName}
          spellCheck={false}
          onChange={(event) => setProjectName(event.target.value)}
        />
      </div>

      <div className="top-bar__modes">
        <SegmentedControl<EditorMode>
          label="Editor mode"
          options={MODE_OPTIONS}
          value={mode}
          onChange={setMode}
        />
        <span className="top-bar__snap">
          <SegmentedToggle
            label="SNAP"
            // A ruled square: the grid the step is measured against.
            icon="▦"
            iconOnly
            pressed={snapEnabled}
            hint={snapHint}
            onChange={(enabled) => setPreferences({ snapEnabled: enabled })}
          />
          <Select<SnapMode>
            label="Snap to"
            hideLabel
            value={snapMode}
            options={SNAP_OPTIONS}
            hint="What the steps are measured in: GRID lands on the squares themselves, CUSTOM opens a field for a step of your own"
            onChange={(mode) => setPreferences({ snapMode: mode })}
          />
          {snapMode === 'custom' ? (
            <NumberField
              label="Snap step"
              hideLabel
              value={snapStep}
              min={MIN_SNAP_STEP}
              max={MAX_SNAP_STEP}
              step={0.01}
              hint="The step, as a multiple of the grid SCALE set in preferences: 1 is one whole square, 0.03 three hundredths of one. This adjustment is is saved with your preferences."
              onChange={(step) => setPreferences({ snapStep: step })}
            />
          ) : null}
        </span>
        <SegmentedToggle
          label="PROP"
          // A point with its falloff ring around it, the same ring the
          // viewport draws once this is on.
          icon="◉"
          iconOnly
          pressed={proportional.enabled}
          disabled={mode !== 'edit'}
          hint={
            mode === 'edit'
              ? `Proportional editing: a transform also drags nearby geometry (${proportional.falloff} falloff)`
              : 'Proportional editing: edit mode only (Tab)'
          }
          onChange={(enabled) => setProportional({ enabled })}
        />
        <SegmentedToggle
          label="AUTO MERGE"
          // Two corners meeting at one point: the weld itself.
          icon="⋈"
          iconOnly
          pressed={autoMerge.enabled}
          disabled={mode !== 'edit'}
          hint={
            mode === 'edit'
              ? `Auto merge: vertices left within ${autoMerge.threshold} of each other are merged into one. Configure the distance in the topology panel`
              : 'Auto merge: edit mode only (Tab)'
          }
          onChange={(enabled) => setAutoMerge({ enabled })}
        />
        <SegmentedToggle
          label="ORTHO"
          // Parallel projection: the square a perspective camera would taper.
          icon="▱"
          iconOnly
          className="top-bar__ortho"
          pressed={orthographic}
          hint="Orthographic camera: no perspective, so parallel lines stay parallel"
          onChange={(value) => setViewportSetting({ orthographic: value })}
        />
        <SegmentedToggle
          label="SMOOTH"
          // A ball half in shadow: the gradient across a face that shading
          // smooth is asking for, against the flat one it replaces.
          icon="◐"
          iconOnly
          pressed={smoothShaded}
          disabled={!activeObject}
          hint={
            activeObject
              ? 'Shade smooth: blend the normals across faces instead of faceting them. In edit mode it applies to the selected faces alone'
              : 'Shade smooth: select an object first'
          }
          onChange={(smooth) => exec('shade', { smooth }, smooth ? 'Shade smooth' : 'Shade flat')}
        />
        <span className="top-bar__pivot">
          <Select<PivotMode>
            label="PIVOT"
            options={PIVOT_OPTIONS}
            value={pivot}
            hint="What a turn or a scale happens around (Ctrl + . toggles through the three)"
            onChange={setPivot}
          />
        </span>
        <TopBarMenu
          label={shadingLabel}
          ariaLabel={`Shading: ${shadingLabel}`}
          menuLabel="SHADING"
          className="top-bar__menu--shading"
          hint="Viewport shading: how surfaces are drawn (Shift+Z cycles)"
          entries={shadingEntries}
        />
        <TopBarMenu
          label="OVERLAYS"
          menuLabel="OVERLAYS"
          hint="What the viewport draws over the scene: tick as many as you need"
          entries={overlayEntries}
        />
      </div>

      <div className="top-bar__actions">
        <IconButton
          label="HISTORY"
          // A stack of steps, which is what the dialog lists.
          icon="▤"
          className="top-bar__icon"
          hint={
            undoSteps > 0
              ? `Undo history: ${undoSteps} ${undoSteps === 1 ? 'step' : 'steps'} to go back through, click one to travel there`
              : 'Undo history: nothing to go back to yet'
          }
          onClick={() => openDialog('history')}
        />
        <IconButton
          label="FRAME SEL"
          // Crosshair over a point: the camera centres on what is selected.
          icon="⌖"
          className="top-bar__icon"
          hint="Frame the camera on selection (.)"
          onClick={frameSelected}
        />
        <IconButton
          label="FRAME ALL"
          // The corners of a frame drawn around everything there is.
          icon="⛶"
          className={cx('top-bar__icon', viewLost && 'top-bar__icon--tremble')}
          hint={
            viewLost
              ? "You've zoomed out past your scene: click to come back"
              : 'Frame the camera on the whole scene (Home)'
          }
          onClick={frameAll}
        />
        <Button
          label="?"
          variant="ghost"
          hint="Keyboard shortcuts (Shift+?)"
          onClick={() => openDialog('shortcuts')}
        />
      </div>
    </header>
  );
}

interface TopBarMenuProps {
  /** Written on the trigger: the value in force, for a menu that picks one of a set. */
  label: string;
  /** Header strip on the open menu, and its accessible name. */
  menuLabel: string;
  entries: readonly ContextMenuEntry[];
  hint: string;
  /** Overrides the accessible name where the trigger wears a value rather than a noun. */
  ariaLabel?: string;
  className?: string;
}

/**
 * A drop-down hung off a top-bar button.
 *
 * Portalled to the body: the header is a flex row an inline menu would stretch,
 * and what hangs below the bar would be cropped by the panels underneath.
 */
function TopBarMenu({ label, menuLabel, entries, hint, ariaLabel, className }: TopBarMenuProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  return (
    <span className={cx('top-bar__menu', className)} ref={anchor}>
      <Button
        label={label}
        variant="ghost"
        className="top-bar__menu-trigger"
        hint={hint}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={(event) => {
          if (at) {
            setAt(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setAt({ x: rect.left, y: rect.bottom + 4 });
        }}
      />
      {at
        ? createPortal(
            <ContextMenu
              x={at.x}
              y={at.y}
              label={menuLabel}
              entries={entries}
              anchor={anchor}
              onClose={() => setAt(null)}
            />,
            document.body,
          )
        : null}
    </span>
  );
}
