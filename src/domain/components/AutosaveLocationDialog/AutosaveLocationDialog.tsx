import { useState } from 'react';

import { Button, Modal } from '@shared/components';
import { useEditorStore } from '@store/index';

import { allowAutosaveLocation } from '../../hooks/useAutosave';
import { autosaveLocationLabel } from '../../services/autosave';

import './AutosaveLocationDialog.scss';

/**
 * The question the editor opens on when autosave is on but the browser has
 * taken back its leave to write to the chosen location, which it does with
 * every restart, and only a click can ask for it again.
 *
 * Closing it leaves autosave on with nowhere it may write: nothing is
 * auto-saved until the location is allowed, from PREFS or from this question
 * the next time the editor opens.
 */
export function AutosaveLocationDialog() {
  const open = useEditorStore((state) => state.dialog === 'autosaveLocation');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const setPreferences = useEditorStore((state) => state.setPreferences);
  const location = useEditorStore((state) => state.autosaveLocation);
  const [asking, setAsking] = useState(false);

  /** Stays open when the prompt is refused, with the choice still on it. */
  const allow = async () => {
    setAsking(true);
    try {
      if (await allowAutosaveLocation()) closeDialog();
    } finally {
      setAsking(false);
    }
  };

  const label = location ? autosaveLocationLabel(location) : 'the autosave location';

  return (
    <Modal
      title="AUTOSAVE LOCATION"
      open={open}
      onClose={closeDialog}
      footer={
        <>
          <Button
            label="TURN AUTOSAVE OFF"
            disabled={asking}
            onClick={() => {
              setPreferences({ autosaveEnabled: false });
              closeDialog();
            }}
          />
          <Button label="ALLOW" variant="primary" disabled={asking} onClick={() => void allow()} />
        </>
      }
    >
      <p className="autosave-location__warning">Let autosave write to {label} again?</p>
      <p className="autosave-location__detail">
        The browser asks again after every restart. Where it offers to allow this on every visit,
        choosing that stops the question. Until you allow it, nothing is auto-saved.
      </p>
    </Modal>
  );
}
