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

import './App.scss';

/**
 * Application shell.
 *
 * Reads as a declarative summary of the layout: all behaviour lives in the
 * hooks above and in the store the panels talk to.
 */
export function App() {
  useKeymap();
  useAutosave();

  const mode = useEditorStore((state) => state.mode);

  return (
    <div className="app-shell">
      <TopBar />

      <div className="app-shell__main">
        <ToolRail />

        <div className="app-shell__left">
          <AddPanel />
          {mode === 'edit' ? <OperationsPanel /> : null}
        </div>

        <ViewportCanvas />

        <div className="app-shell__right">
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
      <TooltipHost />
    </div>
  );
}
