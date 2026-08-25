import {
  DEFAULT_PRIMITIVE_PARAMS,
  METRE_PARAMS,
  PRIMITIVE_DEFAULT_OVERRIDES,
  PRIMITIVE_FIELDS,
  PRIMITIVE_LABELS,
  type PrimitiveKind,
} from '@kernel/index';
import { Button, FieldRow, Panel, SegmentedControl, Toggle } from '@shared/components';
import { useEditorStore } from '@store/index';
import type { PivotMode, SelectMode, ShadingMode } from '@store/types';

import './AddPanel.scss';

const PRIMITIVE_ORDER: PrimitiveKind[] = [
  'box',
  'plane',
  'circle',
  'grid',
  'uvSphere',
  'icoSphere',
  'cylinder',
  'cone',
  'capsule',
  'torus',
];

/** How each measured param reads inside a hint. */
const MEASURE_WORDS: Record<string, string> = {
  size: 'size',
  radius: 'radius',
  radius2: 'tube',
  height: 'height',
};

/**
 * The size a fresh primitive comes in at, as "radius 1 m, height 2 m".
 *
 * Read off the same defaults the add action uses so the figures quoted in the
 * hints cannot drift away from the shapes the buttons actually make. Every
 * length in the editor is metres — one unit is one metre.
 */
function measures(kind: PrimitiveKind): string {
  const params = { ...DEFAULT_PRIMITIVE_PARAMS, ...PRIMITIVE_DEFAULT_OVERRIDES[kind] };
  return PRIMITIVE_FIELDS[kind]
    .filter((field) => METRE_PARAMS.has(field))
    .map((field) => `${MEASURE_WORDS[field]} ${params[field]} m`)
    .join(', ');
}

const PRIMITIVE_HINTS: Record<PrimitiveKind, string> = {
  box: `Adds a six-sided cube at the 3D cursor (${measures('box')})`,
  plane: `Adds a single flat quad at the 3D cursor (${measures('plane')})`,
  circle: `Adds a flat n-gon or an open ring of edges (${measures('circle')})`,
  grid: `Adds a subdivided flat plane, useful as a base mesh (${measures('grid')})`,
  uvSphere: `Adds a sphere built from latitude/longitude rings (${measures('uvSphere')})`,
  icoSphere: `Adds a sphere built from subdivided triangles (${measures('icoSphere')})`,
  cylinder: `Adds a capped or open cylindrical tube (${measures('cylinder')})`,
  cone: `Adds a cone tapering to a single apex vertex (${measures('cone')})`,
  capsule: `Adds a cylinder closed off with a rounded dome at each end (${measures('capsule')})`,
  torus: `Adds a ring swept around a tube radius (${measures('torus')})`,
};

const SELECT_MODE_OPTIONS = [
  { value: 'vertex', label: 'VERT', shortcut: '1', hint: 'Select individual vertices (1)' },
  { value: 'edge', label: 'EDGE', shortcut: '2', hint: 'Select edges; Alt+click follows a loop (2)' },
  { value: 'face', label: 'FACE', shortcut: '3', hint: 'Select whole faces (3)' },
] as const;

// Kept short: five segments share a 260px panel, and the control must not clip.
const SHADING_OPTIONS = [
  { value: 'solid', label: 'SOLID', hint: 'Flat-lit solid surfaces, no edges' },
  { value: 'solidWire', label: 'WIRE+', hint: 'Solid surfaces with the wireframe overlaid' },
  { value: 'wireframe', label: 'WIRE', hint: 'Edges only, no filled surfaces' },
  { value: 'xray', label: 'XRAY', hint: 'Transparent surfaces to see through the mesh' },
  { value: 'matcap', label: 'MCAP', hint: 'A material-capture preview shading' },
] as const;

export function AddPanel() {
  const mode = useEditorStore((state) => state.mode);
  const selectMode = useEditorStore((state) => state.selectMode);
  const setSelectMode = useEditorStore((state) => state.setSelectMode);
  const addPrimitive = useEditorStore((state) => state.addPrimitive);
  const duplicateSelected = useEditorStore((state) => state.duplicateSelected);
  const applyTransform = useEditorStore((state) => state.applyTransformToSelected);
  const exec = useEditorStore((state) => state.exec);
  const shading = useEditorStore((state) => state.shading);
  const setShading = useEditorStore((state) => state.setShading);
  const overlays = useEditorStore((state) => state.overlays);
  const setOverlay = useEditorStore((state) => state.setOverlay);
  const frameSelected = useEditorStore((state) => state.frameSelected);
  const frameAll = useEditorStore((state) => state.frameAll);
  const orthographic = useEditorStore((state) => state.orthographic);
  const setViewportSetting = useEditorStore((state) => state.setViewportSetting);
  const viewLost = useEditorStore((state) => state.viewLost);
  const pivot = useEditorStore((state) => state.pivot);
  const setPivot = useEditorStore((state) => state.setPivot);

  return (
    <Panel title={mode === 'object' ? 'ADD / SCENE' : 'SELECT / VIEW'} className="add-panel">
      {mode === 'object' ? (
        <>
          <FieldRow legend="PRIMITIVES" columns={2}>
            {PRIMITIVE_ORDER.map((kind) => (
              <Button
                key={kind}
                label={PRIMITIVE_LABELS[kind]}
                hint={PRIMITIVE_HINTS[kind]}
                onClick={() => addPrimitive(kind)}
              />
            ))}
          </FieldRow>

          <FieldRow legend="OBJECT" columns={1}>
            <Button
              label="DUPLICATE"
              hint="Copy the selected object(s) with an independent mesh"
              onClick={() => duplicateSelected(false)}
            />
            <Button
              label="LINKED DUPLICATE"
              hint="Copy the selected object(s) sharing the same mesh data"
              onClick={() => duplicateSelected(true)}
            />
            <Button
              label="APPLY TRANSFORM"
              hint="Bake rotation and scale into the mesh so modifiers and exports see the real shape"
              onClick={applyTransform}
            />
            <Button
              label="RECALCULATE NORMALS"
              hint="Make winding consistent and point normals outward (X / Delete removes the object)"
              onClick={() => exec('recalculateNormals', { outside: true }, 'Recalculate normals')}
            />
          </FieldRow>
        </>
      ) : (
        <FieldRow legend="SELECT MODE" columns={1}>
          <SegmentedControl<SelectMode>
            label="Select mode"
            options={SELECT_MODE_OPTIONS}
            value={selectMode}
            onChange={setSelectMode}
          />
        </FieldRow>
      )}

      <FieldRow legend="SHADING" columns={1}>
        <SegmentedControl<ShadingMode>
          label="Shading mode"
          options={SHADING_OPTIONS}
          value={shading}
          onChange={setShading}
        />
      </FieldRow>

      <FieldRow legend="TRANSFORM" columns={1}>
        <SegmentedControl
          label="PIVOT"
          value={pivot === 'cursor' ? 'cursor' : 'median'}
          options={[
            {
              value: 'median',
              label: 'MEDIAN',
              hint: 'Rotate and scale around the middle of what is selected',
            },
            {
              value: 'cursor',
              label: 'CURSOR',
              hint: 'Rotate and scale around the 3D cursor instead',
            },
          ]}
          onChange={(value) => setPivot(value as PivotMode)}
        />
      </FieldRow>

      <FieldRow legend="OVERLAYS" columns={1}>
        <Toggle
          label="GRID"
          checked={overlays.grid}
          hint="Show the ground grid — 1 m squares at normal zoom, rescaled by ten as you pull back"
          onChange={(grid) => setOverlay({ grid })}
        />
        <Toggle
          label="AXES"
          checked={overlays.axes}
          hint="Show the coloured X/Z axis lines"
          onChange={(axes) => setOverlay({ axes })}
        />
        <Toggle
          label="3D CURSOR"
          checked={overlays.cursor}
          hint="Show the 3D cursor ring in the viewport — hiding it does not move it"
          onChange={(cursor) => setOverlay({ cursor })}
        />
        <Toggle
          label="NORMALS"
          checked={overlays.normals}
          hint="Draw a short line out of every face along its normal"
          onChange={(normals) => setOverlay({ normals })}
        />
        <Toggle
          label="FACE ORIENT"
          checked={overlays.faceOrientation}
          hint="Tint backfaces red so inverted normals are obvious"
          onChange={(faceOrientation) => setOverlay({ faceOrientation })}
        />
        <Toggle
          label="STATISTICS"
          checked={overlays.statistics}
          hint="Show vertex/edge/face/triangle counts in the status bar"
          onChange={(statistics) => setOverlay({ statistics })}
        />
        <Toggle
          label="ORTHOGRAPHIC"
          checked={orthographic}
          hint="Switch between perspective and orthographic projection"
          onChange={(value) => setViewportSetting({ orthographic: value })}
        />
      </FieldRow>

      <FieldRow legend="VIEW" columns={2}>
        <Button
          label="FRAME SEL"
          hint="Frame the camera on the current selection (.)"
          onClick={frameSelected}
        />
        <Button
          label="FRAME ALL"
          className={viewLost ? 'add-panel__frame-all--tremble' : undefined}
          hint={
            viewLost
              ? "You've zoomed out past your scene — click to come back"
              : 'Frame the camera on the whole scene'
          }
          onClick={frameAll}
        />
      </FieldRow>
    </Panel>
  );
}
