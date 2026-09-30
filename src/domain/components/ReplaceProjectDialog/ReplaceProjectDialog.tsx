import { useState } from 'react';

import { Button, Modal } from '@shared/components';
import { useEditorStore } from '@store/index';

import { autosaveLocationLabel } from '../../services/autosave';
import type { SaveResult } from '../../services/download';

import './ReplaceProjectDialog.scss';

export interface ReplaceProjectDialogProps {
  /** Starts the fresh project, which the file hook owns. */
  onNew: () => void;
  /** Opens the picker and loads whatever is chosen, over this project. */
  onOpen: () => Promise<void>;
  /** Writes the .3doo, and says whether it landed. */
  onSave: () => Promise<SaveResult>;
}

/**
 * The offer to save before the project on screen is replaced.
 *
 * Two routes lead here, FILE > NEW and FILE > OPEN, because they cost the same
 * thing: the scene on screen and every undo step behind it. The browser keeps
 * no copy of a project, so whatever is in no file is gone, and undo cannot
 * reach back across either.
 *
 * Three ways out, the way every editor with something to lose does it: save
 * and go on, go on anyway, or stay. Pointing at Ctrl+S and leaving the user to
 * find their own way back is how the save gets skipped.
 */
export function ReplaceProjectDialog({ onNew, onOpen, onSave }: ReplaceProjectDialogProps) {
  const dialog = useEditorStore((state) => state.dialog);
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const projectName = useEditorStore((state) => state.projectName);
  const objectCount = useEditorStore((state) => state.objects.length);
  const dirty = useEditorStore((state) => state.dirty);
  const autosaveFolder = useEditorStore((state) =>
    state.autosaveEnabled && state.autosaveLocation
      ? autosaveLocationLabel(state.autosaveLocation)
      : null,
  );
  const [saving, setSaving] = useState(false);

  const opening = dialog === 'openProject';
  const open = opening || dialog === 'newProject';
  const name = projectName?.toLocaleUpperCase() || 'untitled';

  const replace = async () => {
    closeDialog();
    await (opening ? onOpen() : onNew());
  };

  /**
   * Replaces the project once the file is actually written.
   *
   * A dismissed picker leaves the dialog standing with the choice still on it,
   * rather than discarding the work over a save that never happened. The same
   * goes for a name already taken, where the toast says so over the top of
   * this.
   */
  const saveThenReplace = async () => {
    setSaving(true);
    try {
      const result = await onSave();
      if (result.status === 'saved' || result.status === 'downloaded') await replace();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={opening ? 'OPEN A PROJECT FILE' : 'START A NEW PROJECT'}
      open={open}
      onClose={closeDialog}
      footer={
        <>
          <Button label="CANCEL" disabled={saving} onClick={closeDialog} />
          <Button
            label={opening ? 'OPEN WITHOUT SAVING' : 'START WITHOUT SAVING'}
            variant="danger"
            disabled={saving}
            onClick={() => void replace()}
          />
          <Button
            label={saving ? 'SAVING...' : opening ? 'SAVE AND OPEN' : 'SAVE AND START'}
            variant="primary"
            disabled={saving}
            onClick={() => void saveThenReplace()}
          />
        </>
      }
    >
      <p className="replace-project__warning">Save this project to a file first?</p>
      <p className="replace-project__detail">
        {opening ? 'Opening a file' : 'Starting a new project'} replaces {name}, {objectCount}{' '}
        {objectCount === 1 ? 'object' : 'objects'}, and every undo step behind it.{' '}
        {autosaveFolder
          ? `The auto-saves in ${autosaveFolder} stay where they are, and FILE > OPEN brings any of them back.${
              dirty ? ' Changes since the last save are in no file yet.' : ''
            }`
          : 'Autosave is off, so only a file you save yourself has this scene in it.'}
      </p>
    </Modal>
  );
}
