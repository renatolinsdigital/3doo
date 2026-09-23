import { useEffect } from 'react';

import { useEditorStore } from '@store/index';

import { hydrateAssets, syncAssets } from '../services/assets';
import { readAutosave, writeAutosave } from '../services/autosave';

/**
 * Whether this page load has already decided what to open on.
 *
 * Module scope rather than a ref, for two reasons. Walking to DOCS and back
 * remounts this hook, and an empty scene at that point is one the user emptied
 * on purpose: putting a cube back in front of them would be the editor
 * arguing. And StrictMode mounts the hook, unmounts it and mounts it again, so
 * a per-mount guard would let the first mount claim the read and the second
 * find it already claimed, leaving the tab with neither a recovered session
 * nor a cube.
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
 *
 * The scene description goes to IndexedDB and any imported images to OPFS,
 * both of them in this browser on this machine and nowhere else. The undo
 * timeline goes with the scene, so a tab that comes back can still take back
 * what it was doing before it went. That last part is the one thing the
 * browser's copy holds and a `.3doo` does not: a file is the scene, not the
 * route taken to it (see docs/saving.md).
 *
 * All of that stops when the AUTOSAVE preference is off: nothing is written,
 * and no session is offered back either. Restoring work from a setting someone
 * turned off is the surprise the setting exists to prevent, so a tab in that
 * state opens on the cube instead.
 */
export function useAutosave(): void {
  const interval = useEditorStore((state) => state.autosaveInterval);

  useEffect(() => {
    if (opened) return;
    // Claimed before the read rather than after it, so the second of
    // StrictMode's two mounts stands down instead of racing this one.
    opened = true;

    // Deliberately not cancelled on unmount: the scene is store state rather
    // than this component's, so a read that lands after a remount is still the
    // right answer, and the object count below is what keeps it from
    // overwriting anything.
    const offered = useEditorStore.getState().autosaveEnabled
      ? readAutosave()
      : Promise.resolve(null);

    void offered.then(async (record) => {
      const state = useEditorStore.getState();
      // Something is already on the table: a scene built while this was still
      // resolving, or a module walked away from and come back to.
      if (state.objects.length > 0) return;

      const objectCount = record?.document.objects.length ?? 0;
      if (record && objectCount > 0) {
        // The record names its images; the bytes come back from OPFS beside it.
        const assets = await hydrateAssets(record.document.assets ?? []);
        state.loadProjectDocument(record.document, true, assets);
        // After the scene rather than before it: loading a document is what an
        // undo does too, and the mirror of labels the dialog renders from is
        // set here, at the end.
        if (record.history) state.restoreHistory(record.history);
        state.pushToast(
          'info',
          `Recovered ${objectCount} object(s) from ${new Date(record.savedAt).toLocaleTimeString()}`,
        );

        // What was just put on screen is what is stored, so nothing here is a
        // change: an untouched recovered session has no reason to be written
        // straight back out.
        state.markSaved();

        // An image the browser no longer has the file for draws as a blank
        // plane, which on its own looks like the import went wrong rather than
        // like the storage was cleared.
        const missing = assets.filter((asset) => !asset.blob);
        if (missing.length > 0) {
          state.pushToast(
            'warning',
            `Could not find the file for ${missing.map((asset) => asset.name).join(', ')}`,
          );
        }
        return;
      }

      // Nothing to come back to, so open on a cube. Undoable like any other
      // add, so anyone who wants the empty viewport is one Ctrl+Z from it.
      state.addPrimitive('cube');
      // The cube is the editor's doing, not the user's. A tab opened and left
      // alone has nothing worth keeping, so it is not counted as a change.
      state.markSaved();
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = useEditorStore.getState();
      if (!state.autosaveEnabled) return;
      // Nothing has changed since the last write, or since the scene arrived:
      // an editor sitting open with nobody at it does not keep rewriting the
      // same document.
      if (!state.dirty) return;
      if (state.objects.length === 0) return;

      // Marked before the write rather than after it, so an edit made while it
      // is in flight raises the flag again and is caught by the next tick
      // instead of being swallowed by this one.
      state.markSaved();
      void writeAutosave(state.snapshotDocument(), state.snapshotHistory()).then((written) => {
        // The status bar flashes a disk off this, so it is noted once the
        // write has actually landed rather than when it was sent: a flash for
        // a write that failed is the one thing this is there to rule out.
        if (written) useEditorStore.getState().noteAutosaved();
        else useEditorStore.getState().markDirty();
      });
      // The images go beside it, and this is where one whose object has been
      // deleted and left deleted is finally dropped.
      void syncAssets(Object.values(state.assets));
    }, interval * 1000);

    return () => window.clearInterval(timer);
  }, [interval]);
}
