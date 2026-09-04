import { Button, Modal } from '@shared/components';
import { cx } from '@shared/utils/cx';
import { useEditorStore } from '@store/index';

import './HistoryDialog.scss';

/**
 * The undo timeline, as a list you can click into.
 *
 * Reads downward like the status bar's own account of what happened: the steps
 * still ahead at the top, where the scene stands now in the middle, and the
 * edits behind it below, newest first. Clicking any of them travels there in
 * one move rather than in that many presses of Ctrl+Z.
 *
 * It stays open while you travel, so a trip that went too far is one click back.
 */
export function HistoryDialog() {
  const open = useEditorStore((state) => state.dialog === 'history');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const undoSteps = useEditorStore((state) => state.historyUndo);
  const redoSteps = useEditorStore((state) => state.historyRedo);
  const historySize = useEditorStore((state) => state.historySize);
  const undoTimes = useEditorStore((state) => state.undoTimes);
  const redoTimes = useEditorStore((state) => state.redoTimes);

  const kept = undoSteps.length + redoSteps.length;

  return (
    <Modal
      title="HISTORY"
      open={open}
      onClose={closeDialog}
      footer={<Button label="CLOSE" onClick={closeDialog} />}
    >
      {kept === 0 ? (
        <p className="history-dialog__empty">
          Nothing to go back to yet. Every edit lands here as you work, and this is where you pick
          one to return to.
        </p>
      ) : (
        <ol className="history-dialog__list">
          {/* Furthest ahead first, so the step nearest the present sits closest
              to the NOW row and the list reads as one timeline. */}
          {redoSteps
            .map((label, index) => ({ label, steps: index + 1 }))
            .reverse()
            .map(({ label, steps }) => (
              <li key={`redo-${steps}`}>
                <button
                  type="button"
                  className="history-dialog__step history-dialog__step--ahead"
                  onClick={() => redoTimes(steps)}
                >
                  <span className="history-dialog__label">{label}</span>
                  <span className="history-dialog__count">{steps} forward</span>
                </button>
              </li>
            ))}

          <li className="history-dialog__now" aria-current="step">
            NOW
          </li>

          {undoSteps.map((label, index) => (
            <li key={`undo-${index}`}>
              <button
                type="button"
                className={cx('history-dialog__step', index === 0 && 'history-dialog__step--next')}
                onClick={() => undoTimes(index + 1)}
              >
                <span className="history-dialog__label">{label}</span>
                <span className="history-dialog__count">
                  {index === 0 ? 'Ctrl+Z' : `${index + 1} back`}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      <p className="history-dialog__hint">
        {kept} of {historySize} steps kept. Each one holds a whole copy of the scene, so the oldest
        drops off the end as new ones arrive. Set the size in preferences.
      </p>
    </Modal>
  );
}
