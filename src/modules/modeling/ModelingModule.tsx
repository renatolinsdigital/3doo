import { useRef } from 'react';

import { ModuleSwitcher } from '@app/ModuleSwitcher/ModuleSwitcher';
import { ToastHost, TooltipHost } from '@shared/components';
import { useEditorStore } from '@store/index';

import {
  AddPanel,
  ExportDialog,
  MergeDialog,
  ModifierStack,
  OperationsPanel,
  Outliner,
  PreferencesDialog,
  PropertiesPanel,
  ShortcutOverlay,
  StatusBar,
  ToolRail,
  TopBar,
  ViewportCanvas,
} from '@domain/components';
import { useAutosave } from '@domain/hooks/useAutosave';
import { useKeymap } from '@domain/hooks/useKeymap';

import './ModelingModule.scss';

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
    <div className="modeling-shell">
      <TopBar brand={<ModuleSwitcher />} />

      <div className="modeling-shell__main" ref={mainRef}>
        <ToolRail />

        <div className="modeling-shell__left">
          <AddPanel />
          {mode === 'edit' ? <OperationsPanel /> : null}
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
