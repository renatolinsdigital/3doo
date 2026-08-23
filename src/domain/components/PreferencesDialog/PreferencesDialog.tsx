import { Modal, Toggle } from '@shared/components';
import { useEditorStore } from '@store/index';

import './PreferencesDialog.scss';

export function PreferencesDialog() {
  const open = useEditorStore((state) => state.dialog === 'preferences');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const tooltipsEnabled = useEditorStore((state) => state.tooltipsEnabled);
  const setTooltipsEnabled = useEditorStore((state) => state.setTooltipsEnabled);

  return (
    <Modal title="PREFERENCES" open={open} onClose={closeDialog}>
      <Toggle
        label="SHOW HINT TOOLTIPS"
        checked={tooltipsEnabled}
        onChange={setTooltipsEnabled}
      />
      <p className="preferences-dialog__hint">
        A short description appears after hovering a control for a moment. Turn this off if the
        popups get in the way — the setting is remembered on this device.
      </p>
    </Modal>
  );
}
