import { Button, Modal } from '@shared/components';
import { autosaveIntervalLabel, useEditorStore } from '@store/index';

import './NewProjectDialog.scss';

export interface NewProjectDialogProps {
  /** Runs the reset itself, which the file hook owns. */
  onConfirm: () => void;
}

/**
 * One of the two confirmations in the editor, because this is the one action
 * undo cannot take back. The other is the reload prompt, which is about losing
 * the work since the last autosave rather than the autosave itself.
 *
 * The autosave keeps a single project, the one being worked on, so starting a
 * new one is also what discards the old one from this browser. Anyone who
 * wanted that copy wanted it a moment ago, not after the click.
 */
export function NewProjectDialog({ onConfirm }: NewProjectDialogProps) {
  const open = useEditorStore((state) => state.dialog === 'newProject');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const autosaveEnabled = useEditorStore((state) => state.autosaveEnabled);
  const autosaveInterval = useEditorStore((state) => state.autosaveInterval);
  const projectName = useEditorStore((state) => state.projectName);
  const objectCount = useEditorStore((state) => state.objects.length);

  return (
    <Modal
      title="START A NEW PROJECT"
      open={open}
      onClose={closeDialog}
      footer={
        <>
          <Button label="CANCEL" onClick={closeDialog} />
          <Button
            label="PROCEED"
            variant="primary"
            onClick={() => {
              closeDialog();
              onConfirm();
            }}
          />
        </>
      }
    >
      <p className="new-project__warning">Auto-saved data will be lost. Proceed?</p>
      <p className="new-project__detail">
        The autosave holds one project at a time: {projectName || 'untitled'}, {objectCount}{' '}
        {objectCount === 1 ? 'object' : 'objects'}. Starting a new one clears it from this browser,
        along with any images imported into it, and no undo reaches back past that. Cancel and press
        Ctrl+S first to keep a copy as a file.
      </p>
      <p className="new-project__detail">
        {autosaveEnabled
          ? `Autosave is on, writing every ${autosaveIntervalLabel(autosaveInterval).toLowerCase()}, so this project is already saved in this browser and that is the copy being cleared.`
          : 'Autosave is off, so nothing has been kept in this browser at all: only a file you saved yourself has this scene in it.'}
      </p>
    </Modal>
  );
}
