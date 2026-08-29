import { useRef } from 'react';

import { ModuleSwitcher } from '@app/ModuleSwitcher/ModuleSwitcher';
import { ToastHost, TooltipHost } from '@shared/components';
import { useEditorStore } from '@store/index';

import {
  AddPanel,
  BooleanPanel,
  ExportDialog,
  LoopOperationsPanel,
  MergeDialog,
  ModifierStack,
  ObjectPanel,
  OperationsPanel,
  Outliner,
  PreferencesDialog,
  PropertiesPanel,
  ShortcutOverlay,
  StatusBar,
  ToolRail,
  TopBar,
  TopologyPanel,
  ViewportCanvas,
} from '@domain/components';
import { useAutosave } from '@domain/hooks/useAutosave';
import { useKeymap } from '@domain/hooks/useKeymap';

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

  const mode = useEditorStore((state) => state.mode);
  const mainRef = useRef<HTMLDivElement>(null);

  return (
    <div
      className="modeling-shell"
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

      <div className="modeling-shell__main" ref={mainRef}>
        <ToolRail />

        <div className="modeling-shell__left">
          <AddPanel />
          {mode === 'object' ? (
            <>
              <ObjectPanel />
              <BooleanPanel />
            </>
          ) : (
            <>
              <OperationsPanel />
              <LoopOperationsPanel />
              <TopologyPanel />
            </>
          )}
        </div>

        <ViewportCanvas />

        <div className="modeling-shell__right">
          <Outliner />
          <PropertiesPanel />
          <ModifierStack />
        </div>
      </div>

      <StatusBar />

      <ExportDialog />
      <MergeDialog />
      <PreferencesDialog />
      <ShortcutOverlay />
      <ToastHost />
      <TooltipHost bounds={mainRef} />
    </div>
  );
}
