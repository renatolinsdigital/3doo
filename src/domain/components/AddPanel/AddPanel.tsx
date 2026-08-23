import { PRIMITIVE_LABELS, type PrimitiveKind } from '@kernel/index';
import { Button, FieldRow, Panel, SegmentedControl, Toggle } from '@shared/components';
import { useEditorStore } from '@store/index';
import type { SelectMode, ShadingMode } from '@store/types';

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
  'torus',
];

const SELECT_MODE_OPTIONS = [
  { value: 'vertex', label: 'VERT', shortcut: '1' },
  { value: 'edge', label: 'EDGE', shortcut: '2' },
  { value: 'face', label: 'FACE', shortcut: '3' },
] as const;

// Kept short: five segments share a 260px panel, and the control must not clip.
const SHADING_OPTIONS = [
  { value: 'solid', label: 'SOLID' },
  { value: 'solidWire', label: 'WIRE+' },
  { value: 'wireframe', label: 'WIRE' },
  { value: 'xray', label: 'XRAY' },
  { value: 'matcap', label: 'MCAP' },
] as const;

export function AddPanel() {
  const mode = useEditorStore((state) => state.mode);
  const selectMode = useEditorStore((state) => state.selectMode);
  const setSelectMode = useEditorStore((state) => state.setSelectMode);
  const addPrimitive = useEditorStore((state) => state.addPrimitive);
  const duplicateSelected = useEditorStore((state) => state.duplicateSelected);
  const deleteSelected = useEditorStore((state) => state.deleteSelected);
  const joinSelected = useEditorStore((state) => state.joinSelected);
  const shading = useEditorStore((state) => state.shading);
  const setShading = useEditorStore((state) => state.setShading);
  const overlays = useEditorStore((state) => state.overlays);
  const setOverlay = useEditorStore((state) => state.setOverlay);
  const frameSelected = useEditorStore((state) => state.frameSelected);
  const frameAll = useEditorStore((state) => state.frameAll);
  const orthographic = useEditorStore((state) => state.orthographic);
  const setViewportSetting = useEditorStore((state) => state.setViewportSetting);

  return (
    <Panel title={mode === 'object' ? 'ADD / SCENE' : 'SELECT / VIEW'} className="add-panel">
      {mode === 'object' ? (
        <>
          <FieldRow legend="PRIMITIVES" columns={2}>
            {PRIMITIVE_ORDER.map((kind) => (
              <Button
                key={kind}
                label={PRIMITIVE_LABELS[kind]}
                onClick={() => addPrimitive(kind)}
              />
            ))}
          </FieldRow>

          <FieldRow legend="OBJECT" columns={2}>
            <Button label="DUPLICATE" onClick={() => duplicateSelected(false)} />
            <Button label="LINKED DUP" onClick={() => duplicateSelected(true)} />
            <Button label="JOIN" onClick={joinSelected} />
            <Button label="DELETE" variant="danger" onClick={deleteSelected} />
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

      <FieldRow legend="OVERLAYS" columns={1}>
        <Toggle label="GRID" checked={overlays.grid} onChange={(grid) => setOverlay({ grid })} />
        <Toggle label="AXES" checked={overlays.axes} onChange={(axes) => setOverlay({ axes })} />
        <Toggle
          label="NORMALS"
          checked={overlays.normals}
          onChange={(normals) => setOverlay({ normals })}
        />
        <Toggle
          label="FACE ORIENT"
          checked={overlays.faceOrientation}
          onChange={(faceOrientation) => setOverlay({ faceOrientation })}
        />
        <Toggle
          label="STATISTICS"
          checked={overlays.statistics}
          onChange={(statistics) => setOverlay({ statistics })}
        />
        <Toggle
          label="ORTHOGRAPHIC"
          checked={orthographic}
          onChange={(value) => setViewportSetting({ orthographic: value })}
        />
      </FieldRow>

      <FieldRow legend="VIEW" columns={2}>
        <Button label="FRAME SEL" onClick={frameSelected} />
        <Button label="FRAME ALL" onClick={frameAll} />
      </FieldRow>
    </Panel>
  );
}
