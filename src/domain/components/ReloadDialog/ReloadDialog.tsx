import { useState } from 'react';

import { Button, Modal } from '@shared/components';
import { useEditorStore } from '@store/index';

import { autosaveLocationLabel } from '../../services/autosave';
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
 * of at the browser, which would have reloaded without asking anything. The
 * browser keeps no copy of a project, so a reload opens a fresh scene, and
 * only what is in a file, saved or auto-saved, survives it. With nothing
 * changed since the last save there is nothing to offer, and the keymap leaves
 * the keys to the browser.
 */
export function ReloadDialog({ onSave }: ReloadDialogProps) {
  const open = useEditorStore((state) => state.dialog === 'reload');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const dirty = useEditorStore((state) => state.dirty);
  const autosaveFolder = useEditorStore((state) =>
    state.autosaveEnabled && state.autosaveLocation
      ? autosaveLocationLabel(state.autosaveLocation)
      : null,
  );
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
        {`Reloading opens a fresh scene: this browser keeps no copy of the project. ${
          dirty
            ? 'Changes since the last save are in no file yet, and those go.'
            : 'Nothing on screen has changed since the last save.'
        } ${
          autosaveFolder
            ? `Auto-saves are in ${autosaveFolder}, and FILE > OPEN brings any of them back.`
            : 'Autosave is off, so only a file you save yourself keeps this project.'
        }`}
      </p>
    </Modal>
  );
}
