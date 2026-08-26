import type { ReactNode } from 'react';

import { Button, SegmentedControl, SegmentedToggle } from '@shared/components';
import { useEditorStore } from '@store/index';
import type { EditorMode } from '@store/types';

import { useProjectFiles } from '../../hooks/useProjectFiles';

import './TopBar.scss';

const MODE_OPTIONS = [
  { value: 'object', label: 'OBJECT', shortcut: 'Tab' },
  { value: 'edit', label: 'EDIT', shortcut: 'Tab' },
] as const;

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
  const canUndo = useEditorStore((state) => state.canUndo);
  const canRedo = useEditorStore((state) => state.canRedo);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const openDialog = useEditorStore((state) => state.openDialog);
  const proportional = useEditorStore((state) => state.proportional);
  const setProportional = useEditorStore((state) => state.setProportional);
  const orthographic = useEditorStore((state) => state.orthographic);
  const setViewportSetting = useEditorStore((state) => state.setViewportSetting);

  const { newProject, saveProject, openProject, importMesh } = useProjectFiles();

  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        {brand}
        <label className="top-bar__project">
          <span className="u-visually-hidden">Project name</span>
          <input
            className="top-bar__project-input"
            value={projectName}
            spellCheck={false}
            onChange={(event) => setProjectName(event.target.value)}
          />
        </label>
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
          pressed={orthographic}
          hint="Orthographic camera: no perspective, so parallel lines stay parallel"
          onChange={(value) => setViewportSetting({ orthographic: value })}
        />
      </div>

      <div className="top-bar__actions">
        <Button
          label="NEW"
          variant="ghost"
          hint="Start a blank project, discarding unsaved changes"
          onClick={newProject}
        />
        <Button
          label="OPEN"
          variant="ghost"
          hint="Load a .3doo project file from disk"
          onClick={() => void openProject()}
        />
        <Button
          label="SAVE"
          variant="ghost"
          hint="Save the current project as a .3doo file"
          onClick={() => void saveProject()}
        />
        <Button
          label="IMPORT"
          variant="ghost"
          hint="Import geometry from an OBJ file as a new object"
          onClick={() => void importMesh()}
        />
        <span className="top-bar__divider" aria-hidden="true" />
        <Button
          label="UNDO"
          variant="ghost"
          disabled={!canUndo}
          hint="Undo the last action (Ctrl+Z)"
          onClick={undo}
        />
        <Button
          label="REDO"
          variant="ghost"
          disabled={!canRedo}
          hint="Redo the last undone action (Ctrl+Shift+Z)"
          onClick={redo}
        />
        <span className="top-bar__divider" aria-hidden="true" />
        <Button
          label="PREFS"
          variant="ghost"
          hint="Preferences, including turning hint tooltips on or off"
          onClick={() => openDialog('preferences')}
        />
        <Button
          label="?"
          variant="ghost"
          hint="Keyboard shortcuts (Shift+?)"
          onClick={() => openDialog('shortcuts')}
        />
        <Button
          label="EXPORT"
          variant="primary"
          hint="Export the scene as OBJ or ASCII FBX (Ctrl+E)"
          onClick={() => openDialog('export')}
        />
      </div>
    </header>
  );
}
