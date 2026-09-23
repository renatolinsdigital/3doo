import { useState } from 'react';

import { Button, Modal } from '@shared/components';
import { autosaveIntervalLabel, useEditorStore } from '@store/index';

import type { SaveResult } from '../../services/download';

import './ReplaceProjectDialog.scss';

export interface ReplaceProjectDialogProps {
  /** Starts the fresh project, which the file hook owns. */
  onNew: () => Promise<void>;
  /** Opens the picker and loads whatever is chosen, over this project. */
  onOpen: () => Promise<void>;
  /** Writes the .3doo, and says whether it landed. */
  onSave: () => Promise<SaveResult>;
}

/**
 * The offer to save before the project on screen is replaced.
 *
 * Two routes lead here, FILE > NEW and FILE > OPEN, because they cost the same
 * thing: the autosave holds one project, the one being worked on, so whichever
 * arrives next is what clears this one out of the browser, images and undo
 * timeline included. Undo cannot reach back across either.
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
  const [saving, setSaving] = useState(false);

  const opening = dialog === 'openProject';
  const open = opening || dialog === 'newProject';

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
      <p className="replace-project__warning">
        Auto-saved data will be lost. Save this project to a file first?
      </p>
      <p className="replace-project__detail">
        The autosave holds one project at a time: {projectName?.toLocaleUpperCase() || 'untitled'}, {objectCount}{' '}
        {objectCount === 1 ? 'object' : 'objects'}.{' '}
        {opening ? 'Opening a file' : 'Starting a new project'} clears it from this browser, along
        with any images imported into it and every undo step behind it.
      </p>
    </Modal>
  );
}
