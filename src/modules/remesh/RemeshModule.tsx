import { useEffect, useRef } from 'react';

import { ModuleSwitcher } from '@app/ModuleSwitcher/ModuleSwitcher';
import { ToastHost, TooltipHost } from '@shared/components';
import { useEditorStore } from '@store/index';

import {
  ExportDialog,
  MergeDialog,
  Outliner,
  PreferencesDialog,
  RemeshPanel,
  RemeshPresetPanel,
  RemeshReport,
  ShortcutOverlay,
  StatusBar,
  ToolRail,
  TopBar,
  ViewportCanvas,
} from '@domain/components';
import { useKeymap } from '@domain/hooks/useKeymap';

import './RemeshModule.scss';

/**
 * The auto-retopology module.
 *
 * Same scene, same viewport, same shortcuts — only the panels change, because
 * remeshing is something you do *to* the model you were just modelling, and
 * making it a separate document to import into would be the wrong shape
 * entirely.
 *
 * Autosave is deliberately not mounted here, unlike in the modelling module: a
 * preview puts an uncommitted mesh on the object, and a timer that wrote that
 * to the recovery slot would make a result the user had not kept survive a
 * crash as though they had.
 */
export function RemeshModule() {
  useKeymap();

  const setMode = useEditorStore((state) => state.setMode);
  const revertRemesh = useEditorStore((state) => state.revertRemesh);
  const activeObjectId = useEditorStore((state) => state.activeObjectId);
  const mode = useEditorStore((state) => state.mode);
  const mainRef = useRef<HTMLDivElement>(null);

  // Remeshing acts on whole objects, and the panels here have nothing to say
  // about a vertex selection.
  useEffect(() => {
    setMode('object');
  }, [setMode]);

  // A preview only stands while the object it replaced is the one being looked
  // at, in the mode it was made in. Selecting another object, tabbing into edit
  // mode, or leaving the module puts the original mesh back — otherwise vertex
  // edits would land on a mesh that REVERT is still holding a replacement for.
  useEffect(() => {
    return () => {
      if (useEditorStore.getState().remeshPreview) revertRemesh();
    };
  }, [activeObjectId, mode, revertRemesh]);

  return (
    <div className="remesh-shell">
      <TopBar brand={<ModuleSwitcher />} />

      <div className="remesh-shell__main" ref={mainRef}>
        <ToolRail />

        <div className="remesh-shell__left">
          <RemeshPresetPanel />
          <RemeshPanel />
        </div>

        <ViewportCanvas />

        <div className="remesh-shell__right">
          <Outliner />
          <RemeshReport />
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
