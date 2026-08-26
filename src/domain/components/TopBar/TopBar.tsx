import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import {
  Button,
  ContextMenu,
  IconButton,
  SegmentedControl,
  SegmentedToggle,
  TextField,
  type ContextMenuEntry,
} from '@shared/components';
import { useEditorStore } from '@store/index';
import type { EditorMode, OverlaySettings, PivotMode, ShadingMode } from '@store/types';

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

const PIVOT_OPTIONS = [
  { value: 'median', label: 'MEDIAN', hint: 'Rotate and scale around the middle of the selection' },
  { value: 'cursor', label: 'CURSOR', hint: 'Rotate and scale around the 3D cursor instead' },
] as const;

const OVERLAY_OPTIONS: readonly { key: keyof OverlaySettings; label: string; hint: string }[] = [
  {
    key: 'grid',
    label: 'GRID',
    hint: 'The ground grid — 1 m squares at normal zoom, rescaled by ten as you pull back',
  },
  { key: 'axes', label: 'AXES', hint: 'The coloured X/Z axis lines' },
  {
    key: 'cursor',
    label: '3D CURSOR',
    hint: 'The 3D cursor ring in the viewport — hiding it does not move it',
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
   * The switcher belongs to the app shell, which sits above this layer — and
   * dependencies here point inward, never back up at it.
   */
  brand: ReactNode;
}

export function TopBar({ brand }: TopBarProps) {
  const mode = useEditorStore((state) => state.mode);
  const setMode = useEditorStore((state) => state.setMode);
  const projectName = useEditorStore((state) => state.projectName);
  const setProjectName = useEditorStore((state) => state.setProjectName);
  const openDialog = useEditorStore((state) => state.openDialog);
  const proportional = useEditorStore((state) => state.proportional);
  const setProportional = useEditorStore((state) => state.setProportional);
  const orthographic = useEditorStore((state) => state.orthographic);
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
        <SegmentedToggle
          label="PROP"
          // A point with its falloff ring around it — the same ring the
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
          label="ORTHO"
          // Parallel projection: the square a perspective camera would taper.
          icon="▱"
          iconOnly
          className="top-bar__ortho"
          pressed={orthographic}
          hint="Orthographic camera: no perspective, so parallel lines stay parallel"
          onChange={(value) => setViewportSetting({ orthographic: value })}
        />
        <SegmentedControl<PivotMode>
          label="Pivot"
          options={PIVOT_OPTIONS}
          value={pivot === 'cursor' ? 'cursor' : 'median'}
          onChange={setPivot}
        />
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
          hint="What the viewport draws over the scene — tick as many as you need"
          entries={overlayEntries}
        />
      </div>

      <div className="top-bar__actions">
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
          className={`top-bar__icon${viewLost ? ' top-bar__icon--tremble' : ''}`}
          hint={
            viewLost
              ? "You've zoomed out past your scene — click to come back"
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
  /** Written on the trigger — the value in force, for a menu that picks one of a set. */
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
    <span className={['top-bar__menu', className ?? ''].filter(Boolean).join(' ')} ref={anchor}>
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
