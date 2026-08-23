import { useEffect, useRef } from 'react';

import { useEditorStore } from '@store/index';

import { readAutosave, writeAutosave } from '../services/autosave';

const AUTOSAVE_INTERVAL_MS = 20_000;

/**
 * Periodic autosave plus crash recovery.
 *
 * On mount it offers whatever the last session left behind; after that it
 * writes on an interval, but only when the scene has actually changed, so an
 * idle editor does not keep hitting IndexedDB.
 */
export function useAutosave(): void {
  const lastSavedVersion = useRef(-1);
  const recoveryChecked = useRef(false);

  useEffect(() => {
    if (recoveryChecked.current) return;
    recoveryChecked.current = true;

    let cancelled = false;
    void readAutosave().then((record) => {
      if (cancelled || !record) return;

      const state = useEditorStore.getState();
      if (state.objects.length > 0) return;

      const objectCount = record.document.objects.length;
      if (objectCount === 0) return;

      state.loadProjectDocument(record.document);
      state.pushToast(
        'info',
        `Recovered ${objectCount} object(s) from ${new Date(record.savedAt).toLocaleTimeString()}`,
      );
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
