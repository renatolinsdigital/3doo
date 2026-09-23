import { useState } from 'react';

import { Button, Modal } from '@shared/components';
import { autosaveIntervalLabel, useEditorStore } from '@store/index';

import type { SaveResult } from '../../services/download';

import './ReloadDialog.scss';

export interface ReloadDialogProps {
  /** Writes the .3doo file, which the file hook owns. */
  onSave: () => Promise<SaveResult>;
}

/**
 * The offer to save before a reload takes the tab away.
 *
 * F5 and the hard-reload keys are caught in the keymap and arrive here instead
 * of at the browser, which would have reloaded without asking anything. What
 * comes back after one is the autosave, and that is only ever as new as the
 * last tick that wrote it.
 */
export function ReloadDialog({ onSave }: ReloadDialogProps) {
  const open = useEditorStore((state) => state.dialog === 'reload');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const autosaveEnabled = useEditorStore((state) => state.autosaveEnabled);
  const autosaveInterval = useEditorStore((state) => state.autosaveInterval);
  const dirty = useEditorStore((state) => state.dirty);
  const [saving, setSaving] = useState(false);

  /**
   * Reloads once the file is actually written.
   *
   * A dismissed picker leaves the dialog standing with the choice still on it,
   * rather than reloading over a save that never happened. The same goes for a
   * name already taken, where the toast says so over the top of this.
   */
  const saveThenReload = async () => {
    setSaving(true);
    try {
      const result = await onSave();
      if (result.status === 'saved' || result.status === 'downloaded') window.location.reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="RELOAD THE PAGE"
      open={open}
      onClose={closeDialog}
      footer={
        <>
          <Button label="CANCEL" disabled={saving} onClick={closeDialog} />
          <Button
            label="RELOAD WITHOUT SAVING"
            variant="danger"
            disabled={saving}
            onClick={() => window.location.reload()}
          />
          <Button
            label={saving ? 'SAVING...' : 'SAVE AND RELOAD'}
            variant="primary"
            disabled={saving}
            onClick={() => void saveThenReload()}
          />
        </>
      }
    >
      <p className="reload__warning">Save the project before reloading?</p>
      <p className="reload__detail">
        {autosaveEnabled
          ? `Reloading opens on this browser's copy of the project, which is rewritten every ${autosaveIntervalLabel(autosaveInterval).toLowerCase()}. ${
              dirty
                ? 'There are changes on screen that have not reached it yet, and those go.'
                : "Everything on this scene is saved on Browser's autosave copy."
            }`
          : 'Autosave is off, so this browser has kept nothing to come back to: reloading opens a fresh scene, and the only copy of this project is a file you save yourself.'}
      </p>
    </Modal>
  );
}
