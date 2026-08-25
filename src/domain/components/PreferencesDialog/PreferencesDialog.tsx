import { Button, FieldRow, Modal, NumberField, Toggle } from '@shared/components';
import { MAX_SELECTION_LINE_WIDTH, MIN_SELECTION_LINE_WIDTH, useEditorStore } from '@store/index';

import { downloadText, pickTextFile } from '../../services/download';

import './PreferencesDialog.scss';

export function PreferencesDialog() {
  const open = useEditorStore((state) => state.dialog === 'preferences');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const tooltipsEnabled = useEditorStore((state) => state.tooltipsEnabled);
  const selectionLineWidth = useEditorStore((state) => state.selectionLineWidth);
  const selectionLineColor = useEditorStore((state) => state.selectionLineColor);
  const setPreferences = useEditorStore((state) => state.setPreferences);
  const resetPreferences = useEditorStore((state) => state.resetPreferences);

  const exportPreferences = () => {
    const state = useEditorStore.getState();
    downloadText(
      '3doo-preferences.json',
      JSON.stringify(state.currentPreferences(), null, 2),
      'application/json',
    );
    state.pushToast('success', 'Preferences exported');
  };

  const importPreferences = async () => {
    const file = await pickTextFile('.json,application/json');
    if (!file) return;

    const state = useEditorStore.getState();
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
            hint="Load preferences from a JSON file"
          />
          <Button
            label="EXPORT"
            onClick={exportPreferences}
            hint="Save these preferences to a JSON file"
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
        JSON file you can carry to another browser.
      </p>
    </Modal>
  );
}
