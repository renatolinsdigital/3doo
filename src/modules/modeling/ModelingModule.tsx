import { useRef, useState } from 'react';

import { ModuleSwitcher } from '@app/ModuleSwitcher/ModuleSwitcher';
import { ToastHost, TooltipHost } from '@shared/components';
import { useLongPressMenu } from '@shared/hooks/useLongPressMenu';
import {
  COMPACT_LAYOUT,
  NARROW_LAYOUT,
  TOUCH_FIRST,
  matches,
  useMediaQuery,
} from '@shared/hooks/useMediaQuery';
import { cx } from '@shared/utils/cx';
import { useEditorStore } from '@store/index';

import {
  AddPanel,
  AutosaveLocationDialog,
  BooleanPanel,
  ExportDialog,
  HistoryDialog,
  LoopOperationsPanel,
  McpDialog,
  MergeDialog,
  ModifierStack,
  ObjectPanel,
  OperationsPanel,
  Outliner,
  PreferencesDialog,
  PropertiesPanel,
  QuickBar,
  ReloadDialog,
  SCENE_DRAWER_ID,
  ReplaceProjectDialog,
  ScriptDialog,
  ShortcutOverlay,
  StatusBar,
  ToolRail,
  TopBar,
  TOOLS_DRAWER_ID,
  TopologyPanel,
  ViewportCanvas,
} from '@domain/components';
import { useAutosave } from '@domain/hooks/useAutosave';
import { useKeymap } from '@domain/hooks/useKeymap';
import { useProjectFiles } from '@domain/hooks/useProjectFiles';

import './ModelingModule.scss';

/** Input types whose native menu is the only route to the clipboard actions. */
const TEXT_ENTRY_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_ENTRY_TYPES.has(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * The mesh modelling module.
 *
 * Reads as a declarative summary of the layout: all behaviour lives in the
 * hooks above and in the store the panels talk to. The keymap and autosave are
 * mounted here rather than in the app shell, so the editor's shortcuts do not
 * fire while the user is reading the docs.
 */
export function ModelingModule() {
  useKeymap();
  useAutosave();
  useLongPressMenu();
  const { newProject, openProject, saveProject } = useProjectFiles();

  const mode = useEditorStore((state) => state.mode);
  const panels = useEditorStore((state) => state.panels);
  const mainRef = useRef<HTMLElement>(null);

  // Below desktop width the two columns are drawers, opened from the quick
  // bar. A tablet starts with the scene drawer open, which is how it looked
  // before the drawers existed; a phone has room for neither beside the
  // model, so both start closed.
  const drawers = useMediaQuery(COMPACT_LAYOUT);
  const touch = useMediaQuery(TOUCH_FIRST);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(() => !matches(NARROW_LAYOUT));
  // On a phone the two would sit on top of each other, so opening one puts
  // the other away.
  const toggleTools = () => {
    if (!toolsOpen && matches(NARROW_LAYOUT)) setSceneOpen(false);
    setToolsOpen(!toolsOpen);
  };
  const toggleScene = () => {
    if (!sceneOpen && matches(NARROW_LAYOUT)) setToolsOpen(false);
    setSceneOpen(!sceneOpen);
  };

  // The axis widget stands off the edge by the width of the right column, so
  // emptying that column has to take the width with it or the widget is left
  // hanging over nothing.
  const rightColumn = panels.outliner || panels.properties || panels.modifiers;
  const leftColumn =
    panels.primitives ||
    (mode === 'object'
      ? panels.object || panels.boolean
      : panels.operations || panels.loopOperations || panels.topology);

  return (
    <div
      className={cx(
        'modeling-shell',
        !rightColumn && 'modeling-shell--bare-right',
        toolsOpen && 'modeling-shell--tools-open',
        sceneOpen && 'modeling-shell--scene-open',
      )}
      // Right-clicking the editor is the application's gesture, not the
      // browser's: the viewport, the outliner and the material slots each
      // answer it with a menu of their own, and anywhere else it does nothing
      // rather than opening one about the page. Typing fields keep theirs,
      // which is where cut, copy and paste live. Portalled menus and dialogs
      // are covered too: a portal still bubbles through the React tree.
      onContextMenu={(event) => {
        if (!isTextEntry(event.target)) event.preventDefault();
      }}
    >
      <TopBar brand={<ModuleSwitcher />} />

      <main className="modeling-shell__main" ref={mainRef}>
        {panels.toolRail ? <ToolRail /> : null}

        <aside
          id={TOOLS_DRAWER_ID}
          aria-label="Tool panels"
          className={cx(
            'modeling-shell__left',
            // Nothing to keep clear of once the rail is hidden, so the column
            // takes the edge the rail was holding.
            !panels.toolRail && 'modeling-shell__left--flush',
          )}
        >
          {panels.primitives ? <AddPanel /> : null}
          {mode === 'object' ? (
            <>
              {panels.object ? <ObjectPanel /> : null}
              {panels.boolean ? <BooleanPanel /> : null}
            </>
          ) : (
            <>
              {panels.operations ? <OperationsPanel /> : null}
              {panels.loopOperations ? <LoopOperationsPanel /> : null}
              {panels.topology ? <TopologyPanel /> : null}
            </>
          )}
        </aside>

        <ViewportCanvas />

        <aside id={SCENE_DRAWER_ID} aria-label="Scene panels" className="modeling-shell__right">
          {panels.outliner ? <Outliner /> : null}
          {panels.properties ? <PropertiesPanel /> : null}
          {panels.modifiers ? <ModifierStack /> : null}
        </aside>
      </main>

      {drawers || touch ? (
        <QuickBar
          drawers={drawers}
          touch={touch}
          toolsOpen={toolsOpen}
          sceneOpen={sceneOpen}
          hasTools={leftColumn}
          hasScene={rightColumn}
          onToggleTools={toggleTools}
          onToggleScene={toggleScene}
        />
      ) : null}

      {panels.statusBar ? <StatusBar /> : null}

      <ExportDialog />
      <HistoryDialog />
      <MergeDialog />
      <PreferencesDialog />
      <ReloadDialog onSave={saveProject} />
      <ReplaceProjectDialog onNew={newProject} onOpen={openProject} onSave={saveProject} />
      <AutosaveLocationDialog />
      <ScriptDialog />
      <McpDialog />
      <ShortcutOverlay />
      <ToastHost />
      <TooltipHost bounds={mainRef} />
    </div>
  );
}
