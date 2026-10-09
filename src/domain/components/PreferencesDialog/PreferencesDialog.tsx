import {
  Accordion,
  Button,
  ColorField,
  Modal,
  NumberField,
  Select,
  Slider,
  Toggle,
} from '@shared/components';
import { cx } from '@shared/utils/cx';
import {
  AUTOSAVE_INTERVALS,
  MAX_GRID_SCALE,
  MAX_GRID_SUBDIVISIONS,
  MAX_HISTORY_SIZE,
  MAX_SELECTION_LINE_WIDTH,
  MAX_SNAP_STEP,
  MIN_GRID_SCALE,
  MIN_GRID_SUBDIVISIONS,
  MIN_HISTORY_SIZE,
  MIN_SELECTION_LINE_WIDTH,
  MIN_SNAP_STEP,
  autosaveIntervalLabel,
  useEditorStore,
} from '@store/index';
import type { PanelId, SnapMode, WheelZoom } from '@store/types';

import {
  allowAutosaveLocation,
  chooseAutosaveLocation,
  forgetAutosaveLocation,
  turnAutosaveOn,
} from '../../hooks/useAutosave';
import { AUTOSAVE_FOLDER, autosaveLocationLabel } from '../../services/autosave';
import {
  PREFERENCES_FILE,
  canPickFolder,
  pickTextFile,
  saveResultToast,
  saveTextFile,
  wrongKindMessage,
} from '../../services/download';

import './PreferencesDialog.scss';

/** The intervals the autosave offers, as the picker needs them: strings. */
const AUTOSAVE_INTERVAL_OPTIONS = AUTOSAVE_INTERVALS.map((seconds) => ({
  value: String(seconds),
  label: autosaveIntervalLabel(seconds),
}));

const SNAP_OPTIONS: readonly { value: SnapMode; label: string }[] = [
  { value: 'grid', label: 'GRID' },
  { value: 'custom', label: 'CUSTOM' },
];

const WHEEL_ZOOM_OPTIONS: readonly { value: WheelZoom; label: string }[] = [
  { value: 'pointer', label: 'FOLLOW POINTER' },
  { value: 'centred', label: 'CENTRED' },
];

/**
 * The switches under PANELS VISIBILITY, ordered the way the screen is: down the
 * left, then down the right, then the bar along the foot. Each hint says where
 * the thing stands, so finding one here is no harder than pointing at it.
 */
const PANEL_SWITCHES: readonly { id: PanelId; label: string; hint: string }[] = [
  {
    id: 'toolRail',
    label: 'TOOL RAIL',
    hint: 'The strip of tool buttons on the far left: select, move, rotate and scale. Every one of them keeps its keyboard shortcut with the rail hidden',
  },
  {
    id: 'primitives',
    label: 'PRIMITIVES',
    hint: 'The shapes to add, at the head of the left column. The same panel is titled SELECT in edit mode, where it holds the vertex, edge and face switch',
  },
  {
    id: 'object',
    label: 'OBJECT',
    hint: 'Duplicate, merge, separate, apply transform and recalculate normals, on the left in object mode',
  },
  {
    id: 'boolean',
    label: 'BOOLEAN',
    hint: 'Union, difference and intersect between the selected objects, on the left in object mode',
  },
  {
    id: 'operations',
    label: 'OPERATIONS',
    hint: 'Extrude, inset and bevel, each with the figure it runs on, on the left in edit mode',
  },
  {
    id: 'loopOperations',
    label: 'LOOP OPERATIONS',
    hint: 'Loop cut, subdivide, relax, circle and space, on the left in edit mode',
  },
  {
    id: 'topology',
    label: 'TOPOLOGY',
    hint: 'Build, merge and clean up, the selection grow and shrink, and the auto merge and proportional edit settings, on the left in edit mode',
  },
  {
    id: 'outliner',
    label: 'OUTLINER',
    hint: 'The list of what is in the scene, at the head of the right column',
  },
  {
    id: 'properties',
    label: 'PROPERTIES',
    hint: "The active object's transform, its materials and the parameters of a primitive still open to being re-cut, on the right",
  },
  {
    id: 'modifiers',
    label: 'MODIFIERS',
    hint: "The active object's modifier stack, at the foot of the right column",
  },
  {
    id: 'statusBar',
    label: 'STATUS BAR',
    hint: 'The strip under the viewport: the scene and selection counts, the last operation that ran, and the readout a move, a turn or a scale writes as it goes',
  },
];

export function PreferencesDialog() {
  const open = useEditorStore((state) => state.dialog === 'preferences');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const tooltipsEnabled = useEditorStore((state) => state.tooltipsEnabled);
  const panels = useEditorStore((state) => state.panels);
  const selectionLineWidth = useEditorStore((state) => state.selectionLineWidth);
  const selectionLineColor = useEditorStore((state) => state.selectionLineColor);
  const viewportBackground = useEditorStore((state) => state.viewportBackground);
  const lockVerticalOrbit = useEditorStore((state) => state.lockVerticalOrbit);
  const wheelZoom = useEditorStore((state) => state.wheelZoom);
  const gridScale = useEditorStore((state) => state.gridScale);
  const gridSubdivisions = useEditorStore((state) => state.gridSubdivisions);
  const snapEnabled = useEditorStore((state) => state.snapEnabled);
  const snapMode = useEditorStore((state) => state.snapMode);
  const snapStep = useEditorStore((state) => state.snapStep);
  const historySize = useEditorStore((state) => state.historySize);
  const autosaveEnabled = useEditorStore((state) => state.autosaveEnabled);
  const autosaveInterval = useEditorStore((state) => state.autosaveInterval);
  const autosaveLocation = useEditorStore((state) => state.autosaveLocation);
  const autosaveLocationReady = useEditorStore((state) => state.autosaveLocationReady);
  const gridColor = useEditorStore((state) => state.gridColor);
  const gridOpacity = useEditorStore((state) => state.gridOpacity);
  const gridMajorColor = useEditorStore((state) => state.gridMajorColor);
  const gridMajorOpacity = useEditorStore((state) => state.gridMajorOpacity);
  const setPreferences = useEditorStore((state) => state.setPreferences);
  const resetPreferences = useEditorStore((state) => state.resetPreferences);

  const setPanel = (id: PanelId, visible: boolean) =>
    setPreferences({ panels: { ...panels, [id]: visible } });

  // Whether autosave is possible here at all. It only writes into a folder, so
  // without a folder picker the switch is greyed out and the section says why.
  const folders = canPickFolder();

  // The location is kept apart from the preferences, in IndexedDB, because a
  // folder handle cannot go into a .pref file. RESET clears it all the same.
  const reset = () => {
    resetPreferences();
    void forgetAutosaveLocation();
  };

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
            onClick={reset}
            hint="Put every preference back to its default and forget the autosave LOCATION"
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
      <Accordion title="INTERFACE">
        <Toggle
          label="SHOW HINT TOOLTIPS"
          checked={tooltipsEnabled}
          hint="A short description appears after hovering a control for a moment. Turn this off if the popups get in the way"
          onChange={(enabled) => setPreferences({ tooltipsEnabled: enabled })}
        />
      </Accordion>

      <Accordion title="PANELS VISIBILITY">
        {PANEL_SWITCHES.map((entry) => (
          <Toggle
            key={entry.id}
            label={entry.label}
            checked={panels[entry.id]}
            hint={entry.hint}
            onChange={(visible) => setPanel(entry.id, visible)}
          />
        ))}
        <p className="preferences__hint">
          Hiding one of these only takes it off the screen. Whatever it holds still runs from the
          keyboard and nothing about the scene changes, so it costs you nothing but the room it was
          taking. These are yours rather than the project's, and stay as you left them from one
          scene to the next.
        </p>
      </Accordion>

      <Accordion title="VIEWPORT">
        <ColorField
          label="BACKGROUND"
          value={viewportBackground}
          hint="What the viewport clears to behind the scene. The grid, the axes and the overlays keep their own colours"
          onChange={(color) => setPreferences({ viewportBackground: color })}
        />
        <Toggle
          label="LOCK VERTICAL ORBIT"
          checked={lockVerticalOrbit}
          hint="Stop the orbit at straight up and straight down instead of rolling over"
          onChange={(locked) => setPreferences({ lockVerticalOrbit: locked })}
        />
        <Select<WheelZoom>
          label="WHEEL ZOOM"
          value={wheelZoom}
          options={WHEEL_ZOOM_OPTIONS}
          hint="Where the mouse wheel zooms. FOLLOW POINTER stays mostly centred and drifts toward whatever the pointer is over. CENTRED zooms straight into the middle of the view"
          onChange={(mode) => setPreferences({ wheelZoom: mode })}
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

      <Accordion title="SNAPPING">
        <Toggle
          label="SNAP TRANSFORMS"
          checked={snapEnabled}
          hint="A move, a turn and a scale land on whole steps instead of wherever the pointer left them. The same switch as the one in the top bar"
          onChange={(enabled) => setPreferences({ snapEnabled: enabled })}
        />
        <Select<SnapMode>
          label="SNAP TO"
          value={snapMode}
          options={SNAP_OPTIONS}
          hint="What the steps are measured in: GRID lands on the squares themselves, CUSTOM on the step below. The same picker as the one in the top bar"
          onChange={(mode) => setPreferences({ snapMode: mode })}
        />
        <NumberField
          label="CUSTOM STEP"
          value={snapStep}
          min={MIN_SNAP_STEP}
          max={MAX_SNAP_STEP}
          step={0.05}
          suffix="×"
          disabled={snapMode === 'grid'}
          hint={
            snapMode === 'grid'
              ? 'The step CUSTOM uses, as a multiple of the SCALE above. Set SNAP TO to CUSTOM to use it'
              : 'How far apart the steps are, as a multiple of the SCALE above: 1 is one whole square, 0.1 a tenth of one.'
          }
          onChange={(step) => setPreferences({ snapStep: step })}
        />
      </Accordion>

      <Accordion title="AUTOSAVE">
        <Toggle
          label="AUTOSAVE THE SCENE"
          checked={autosaveEnabled}
          disabled={!folders}
          hint={
            folders
              ? 'Off until you turn it on. With no LOCATION chosen yet, turning it on asks for one first'
              : 'Not available here: autosave writes to a folder, and this browser cannot give it one'
          }
          // The switch can run the folder picker itself: a picker only opens
          // on a click, and this is the click.
          onChange={(enabled) =>
            void (enabled ? turnAutosaveOn() : setPreferences({ autosaveEnabled: false }))
          }
        />
        {folders ? (
          <div className="preferences__location">
            <span className="preferences__location-label">LOCATION</span>
            <div className="preferences__location-value">
              <span
                className={cx(
                  'preferences__location-name',
                  !autosaveLocation && 'preferences__location-name--empty',
                )}
              >
                {autosaveLocation ? autosaveLocationLabel(autosaveLocation) : 'Not chosen'}
              </span>
              {autosaveEnabled && autosaveLocation && !autosaveLocationReady ? (
                <Button
                  label="ALLOW"
                  variant="ghost"
                  className="preferences__location-button"
                  hint="The browser wants your permission again before autosave writes here"
                  onClick={() => void allowAutosaveLocation()}
                />
              ) : null}
              <Button
                label={autosaveLocation ? 'CHANGE' : 'CHOOSE'}
                variant="ghost"
                className="preferences__location-button"
                hint={`Pick the folder auto-saves go in. A ${AUTOSAVE_FOLDER} folder is made inside it`}
                onClick={() => void chooseAutosaveLocation()}
              />
            </div>
          </div>
        ) : null}
        <Select
          label="EVERY"
          value={String(autosaveInterval)}
          options={AUTOSAVE_INTERVAL_OPTIONS}
          disabled={!autosaveEnabled}
          hint="How often a changed scene is written. Shorter costs less when a tab dies; longer leaves fewer copies in the folder and keeps a heavy scene from being written out so often. Nothing is written at all until you change something"
          onChange={(seconds) => setPreferences({ autosaveInterval: Number(seconds) })}
        />
        {folders ? (
          <>
            <p className="preferences__hint">
              Saves to {AUTOSAVE_FOLDER} inside the LOCATION above: NAME_01.3doo, NAME_02.3doo and
              on, where NAME is the .3doo you saved or opened. Nothing is kept in the browser.
            </p>
            <p className="preferences__hint">
              Choosing a location asks you to allow access, and a browser restart asks once more.
              The browser refuses Desktop, Documents and Downloads themselves, so pick a folder
              inside them or anywhere else.
            </p>
          </>
        ) : (
          <p className="preferences__hint">
            Autosave writes numbered copies into a folder you choose, and this browser cannot give
            the editor a folder. Chrome and Edge can. Here, save with Ctrl+S.
          </p>
        )}
      </Accordion>

      <Accordion title="HISTORY">
        <Slider
          label="UNDO STEPS"
          value={historySize}
          min={MIN_HISTORY_SIZE}
          max={MAX_HISTORY_SIZE}
          suffix="steps"
          hint="How many edits Ctrl+Z can walk back through, and how many the history dialog lists"
          onChange={(historySize) => setPreferences({ historySize })}
        />
        <p className="preferences__hint">
          Undo keeps a whole copy of the scene per step, so this figure multiplies the model rather
          than adding to it. Lower it if editing turns sluggish or the tab is killed for memory.
        </p>
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
