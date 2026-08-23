import { Button, SegmentedControl } from '@shared/components';
import { useEditorStore } from '@store/index';
import type { EditorMode } from '@store/types';

import { useProjectFiles } from '../../hooks/useProjectFiles';

import './TopBar.scss';

const MODE_OPTIONS = [
  { value: 'object', label: 'OBJECT', shortcut: 'Tab' },
  { value: 'edit', label: 'EDIT', shortcut: 'Tab' },
] as const;

export function TopBar() {
  const mode = useEditorStore((state) => state.mode);
  const setMode = useEditorStore((state) => state.setMode);
  const projectName = useEditorStore((state) => state.projectName);
  const setProjectName = useEditorStore((state) => state.setProjectName);
  const canUndo = useEditorStore((state) => state.canUndo);
  const canRedo = useEditorStore((state) => state.canRedo);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const openDialog = useEditorStore((state) => state.openDialog);
  const resetScene = useEditorStore((state) => state.resetScene);

  const { saveProject, openProject, importMesh } = useProjectFiles();

  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <span className="top-bar__logo">3DOO</span>
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
      </div>

      <div className="top-bar__actions">
        <Button label="NEW" variant="ghost" onClick={resetScene} />
        <Button label="OPEN" variant="ghost" onClick={() => void openProject()} />
        <Button label="SAVE" variant="ghost" onClick={saveProject} />
        <Button label="IMPORT" variant="ghost" onClick={() => void importMesh()} />
        <span className="top-bar__divider" aria-hidden="true" />
        <Button label="UNDO" variant="ghost" disabled={!canUndo} onClick={undo} />
        <Button label="REDO" variant="ghost" disabled={!canRedo} onClick={redo} />
        <span className="top-bar__divider" aria-hidden="true" />
        <Button label="?" variant="ghost" onClick={() => openDialog('shortcuts')} />
        <Button label="EXPORT" variant="primary" onClick={() => openDialog('export')} />
      </div>
    </header>
  );
}
