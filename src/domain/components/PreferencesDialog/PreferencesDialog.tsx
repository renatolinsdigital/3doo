import { Button, FieldRow, Modal, NumberField, Toggle } from '@shared/components';
import { MAX_SELECTION_LINE_WIDTH, MIN_SELECTION_LINE_WIDTH, useEditorStore } from '@store/index';

import {
  PREFERENCES_FILE,
  pickTextFile,
  saveResultToast,
  saveTextFile,
  wrongKindMessage,
} from '../../services/download';

import './PreferencesDialog.scss';

export function PreferencesDialog() {
  const open = useEditorStore((state) => state.dialog === 'preferences');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const tooltipsEnabled = useEditorStore((state) => state.tooltipsEnabled);
  const selectionLineWidth = useEditorStore((state) => state.selectionLineWidth);
  const selectionLineColor = useEditorStore((state) => state.selectionLineColor);
  const setPreferences = useEditorStore((state) => state.setPreferences);
  const resetPreferences = useEditorStore((state) => state.resetPreferences);

  const exportPreferences = async () => {
    const state = useEditorStore.getState();
    const result = await saveTextFile(
      `3doo${PREFERENCES_FILE.extension}`,
      JSON.stringify(state.currentPreferences(), null, 2),
      PREFERENCES_FILE,
    );

    const toast = saveResultToast(result);
    if (toast) state.pushToast(toast.variant, toast.message);
  };

  const importPreferences = async () => {
    const file = await pickTextFile(PREFERENCES_FILE);
    if (!file) return;

    const state = useEditorStore.getState();

    const wrongKind = wrongKindMessage(file.name, PREFERENCES_FILE);
    if (wrongKind) {
      state.pushToast('error', wrongKind);
      return;
    }

    try {
      state.importPreferences(file.text);
      state.pushToast('success', `Preferences loaded from ${file.name}`);
    } catch (error) {
      state.pushToast('error', (error as Error).message);
    }
  };

  return (
    <Modal
      title="PREFERENCES"
      open={open}
      onClose={closeDialog}
      footer={
        <>
          <Button
            label="RESET"
            onClick={resetPreferences}
            hint="Put every preference back to its default"
          />
          <Button
            label="IMPORT"
            onClick={importPreferences}
            hint="Load preferences from a .pref file"
          />
          <Button
            label="EXPORT"
            onClick={exportPreferences}
            hint="Save these preferences to a .pref file"
          />
          <Button label="DONE" variant="primary" onClick={closeDialog} />
        </>
      }
    >
      <FieldRow legend="INTERFACE" columns={1}>
        <Toggle
          label="SHOW HINT TOOLTIPS"
          checked={tooltipsEnabled}
          onChange={(enabled) => setPreferences({ tooltipsEnabled: enabled })}
        />
        <p className="preferences-dialog__hint">
          A short description appears after hovering a control for a moment. Turn this off if the
          popups get in the way.
        </p>
      </FieldRow>

      <FieldRow legend="SELECTION LINE" columns={1}>
        <p className="preferences-dialog__hint">
          The outline around selected objects in object mode. 
        </p>
        <NumberField
          label="THICKNESS"
          value={selectionLineWidth}
          min={MIN_SELECTION_LINE_WIDTH}
          max={MAX_SELECTION_LINE_WIDTH}
          step={0.5}
          precision={1}
          suffix="px"
          hint="Width of the outline drawn around selected objects"
          onChange={(width) => setPreferences({ selectionLineWidth: width })}
        />
        <div className="preferences-dialog__color">
          <label className="preferences-dialog__color-label" htmlFor="selection-line-color">
            COLOR
          </label>
          <input
            id="selection-line-color"
            className="preferences-dialog__swatch"
            type="color"
            value={selectionLineColor}
            onChange={(event) => setPreferences({ selectionLineColor: event.target.value })}
          />
        </div>
        
      </FieldRow>

      <p className="preferences-dialog__hint bottom">
        Preferences are stored on this device, separately from your project. Export writes them to a
        .pref file you can carry to another browser.
      </p>
    </Modal>
  );
}
