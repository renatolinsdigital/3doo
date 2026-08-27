import { Accordion, Button, ColorField, Modal, NumberField, Toggle } from '@shared/components';
import {
  MAX_GRID_SCALE,
  MAX_GRID_SUBDIVISIONS,
  MAX_SELECTION_LINE_WIDTH,
  MIN_GRID_SCALE,
  MIN_GRID_SUBDIVISIONS,
  MIN_SELECTION_LINE_WIDTH,
  useEditorStore,
} from '@store/index';

import {
  PREFERENCES_FILE,
  pickTextFile,
  saveResultToast,
  saveTextFile,
  wrongKindMessage,
} from '../../services/download';

export function PreferencesDialog() {
  const open = useEditorStore((state) => state.dialog === 'preferences');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const tooltipsEnabled = useEditorStore((state) => state.tooltipsEnabled);
  const selectionLineWidth = useEditorStore((state) => state.selectionLineWidth);
  const selectionLineColor = useEditorStore((state) => state.selectionLineColor);
  const viewportBackground = useEditorStore((state) => state.viewportBackground);
  const gridScale = useEditorStore((state) => state.gridScale);
  const gridSubdivisions = useEditorStore((state) => state.gridSubdivisions);
  const gridColor = useEditorStore((state) => state.gridColor);
  const gridOpacity = useEditorStore((state) => state.gridOpacity);
  const gridMajorColor = useEditorStore((state) => state.gridMajorColor);
  const gridMajorOpacity = useEditorStore((state) => state.gridMajorOpacity);
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
            hint="Save these preferences to a .pref file, to carry to another browser"
          />
          <Button label="DONE" variant="primary" onClick={closeDialog} />
        </>
      }
    >
      <Accordion title="INTERFACE" defaultOpen>
        <Toggle
          label="SHOW HINT TOOLTIPS"
          checked={tooltipsEnabled}
          hint="A short description appears after hovering a control for a moment. Turn this off if the popups get in the way"
          onChange={(enabled) => setPreferences({ tooltipsEnabled: enabled })}
        />
      </Accordion>

      <Accordion title="VIEWPORT">
        <ColorField
          label="BACKGROUND"
          value={viewportBackground}
          hint="What the viewport clears to behind the scene. The grid, the axes and the overlays keep their own colours"
          onChange={(color) => setPreferences({ viewportBackground: color })}
        />
      </Accordion>

      <Accordion title="GRID">
        <NumberField
          label="SCALE"
          value={gridScale}
          min={MIN_GRID_SCALE}
          max={MAX_GRID_SCALE}
          step={0.1}
          suffix="×"
          hint="The plane resizes itself by powers of ten as you zoom, so a square has no fixed length in metres. This multiplies whichever step the zoom lands on: 2 makes every square twice the size, at every zoom"
          onChange={(scale) => setPreferences({ gridScale: scale })}
        />
        <NumberField
          label="SUBDIVISIONS"
          value={gridSubdivisions}
          min={MIN_GRID_SUBDIVISIONS}
          max={MAX_GRID_SUBDIVISIONS}
          integer
          hint="How many squares fall between two heavy lines"
          onChange={(subdivisions) => setPreferences({ gridSubdivisions: subdivisions })}
        />
        <ColorField
          label="SQUARE COLOR"
          value={gridColor}
          hint="Colour of the fine lines, the ones a square is drawn from"
          onChange={(color) => setPreferences({ gridColor: color })}
        />
        <NumberField
          label="SQUARE OPACITY"
          value={gridOpacity}
          min={0}
          max={1}
          step={0.05}
          precision={2}
          hint="How solid the fine lines are at their strongest: 0 hides them, 1 is a flat line. They ease off as a zoom closes them up"
          onChange={(opacity) => setPreferences({ gridOpacity: opacity })}
        />
        <ColorField
          label="HEAVY COLOR"
          value={gridMajorColor}
          hint="Colour of the heavy line drawn every few squares"
          onChange={(color) => setPreferences({ gridMajorColor: color })}
        />
        <NumberField
          label="HEAVY OPACITY"
          value={gridMajorOpacity}
          min={0}
          max={1}
          step={0.05}
          precision={2}
          hint="How solid the heavy lines are: 0 hides them, 1 is a flat line"
          onChange={(opacity) => setPreferences({ gridMajorOpacity: opacity })}
        />
      </Accordion>

      <Accordion title="SELECTION LINE">
        <NumberField
          label="THICKNESS"
          value={selectionLineWidth}
          min={MIN_SELECTION_LINE_WIDTH}
          max={MAX_SELECTION_LINE_WIDTH}
          step={0.5}
          precision={1}
          suffix="px"
          hint="Width of the outline drawn around selected objects in object mode"
          onChange={(width) => setPreferences({ selectionLineWidth: width })}
        />
        <ColorField
          label="COLOR"
          value={selectionLineColor}
          hint="Colour of the outline around selected objects. The active one wears it, the rest a darker mix"
          onChange={(color) => setPreferences({ selectionLineColor: color })}
        />
      </Accordion>
    </Modal>
  );
}
