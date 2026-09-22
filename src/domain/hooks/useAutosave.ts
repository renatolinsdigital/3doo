import { useEffect, useRef } from 'react';

import { useEditorStore } from '@store/index';

import { readAutosave, writeAutosave } from '../services/autosave';

const AUTOSAVE_INTERVAL_MS = 20_000;

/**
 * Whether this page load has already been given its opening scene.
 *
 * Module scope rather than a ref, because walking to DOCS and back remounts
 * this hook, and an empty scene at that point is one the user emptied on
 * purpose. Putting a cube back in front of them would be the editor arguing.
 */
let opened = false;

/**
 * Says whether this page load counts as already opened.
 *
 * A test asking for the browser's own first run passes false; one that builds
 * its own scene passes true, so no cube lands in the middle of it.
 */
export function setOpeningSceneDone(done: boolean): void {
  opened = done;
}

/**
 * What the editor opens on, and the autosave that keeps it.
 *
 * On mount it offers whatever the last session left behind, and opens on a
 * cube when there is nothing to come back to, the way Blender does: an empty
 * viewport gives you nothing to try a tool against, and the first thing
 * anybody does with a fresh tab is add a cube to have something to press keys
 * at. After that it writes on an interval, but only when the scene has
 * actually changed, so an idle editor does not keep hitting IndexedDB.
 */
export function useAutosave(): void {
  const lastSavedVersion = useRef(-1);
  const recoveryChecked = useRef(false);

  useEffect(() => {
    if (recoveryChecked.current) return;
    recoveryChecked.current = true;

    let cancelled = false;
    void readAutosave().then((record) => {
      if (cancelled) return;

      const state = useEditorStore.getState();
      // Something is already on the table: a scene built while this was still
      // resolving, or a module walked away from and come back to.
      if (state.objects.length > 0) return;

      const objectCount = record?.document.objects.length ?? 0;
      if (record && objectCount > 0) {
        state.loadProjectDocument(record.document, true);
        state.pushToast(
          'info',
          `Recovered ${objectCount} object(s) from ${new Date(record.savedAt).toLocaleTimeString()}`,
        );
        opened = true;
        return;
      }

      // Nothing to come back to, so open on a cube. Undoable like any other
      // add, so anyone who wants the empty viewport is one Ctrl+Z from it.
      if (opened) return;
      opened = true;
      state.addPrimitive('cube');
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = useEditorStore.getState();
      if (state.meshVersion === lastSavedVersion.current) return;
      if (state.objects.length === 0) return;

      lastSavedVersion.current = state.meshVersion;
      void writeAutosave(state.snapshotDocument());
    }, AUTOSAVE_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);
}
