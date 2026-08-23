import { useState } from 'react';

import type { AxisPreset, UnitPreset, UpAxis } from '@kernel/index';
import { Button, FieldRow, Modal, NumberField, Select, Toggle } from '@shared/components';
import { useEditorStore } from '@store/index';

import { useProjectFiles } from '../../hooks/useProjectFiles';

import './ExportDialog.scss';

const PRESET_OPTIONS = [
  { value: 'unity', label: 'UNITY (Y-UP, M)' },
  { value: 'unreal', label: 'UNREAL (Z-UP, CM)' },
  { value: 'blender', label: 'BLENDER (Z-UP, M)' },
  { value: 'maya', label: 'MAYA (Y-UP, CM)' },
  { value: 'custom', label: 'CUSTOM' },
] as const;

export function ExportDialog() {
  const open = useEditorStore((state) => state.dialog === 'export');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const options = useEditorStore((state) => state.exportOptions);
  const setExportOptions = useEditorStore((state) => state.setExportOptions);
  const { exportModel } = useProjectFiles();

  const [selectionOnly, setSelectionOnly] = useState(false);

  return (
    <Modal
      title="EXPORT"
      open={open}
      onClose={closeDialog}
      footer={
        <>
          <Button label="CANCEL" onClick={closeDialog} />
          <Button
            label="EXPORT OBJ"
            onClick={() => {
              exportModel('obj', selectionOnly);
              closeDialog();
            }}
          />
          <Button
            label="EXPORT FBX"
            variant="primary"
            onClick={() => {
              exportModel('fbx', selectionOnly);
              closeDialog();
            }}
          />
        </>
      }
    >
      <FieldRow legend="TARGET PRESET" columns={1}>
        <Select<AxisPreset>
          label="PRESET"
          value={options.preset}
          options={PRESET_OPTIONS}
          onChange={(preset) => setExportOptions({ preset })}
        />
        <p className="export-dialog__hint">
          Presets set the axis and unit conventions for you. Pick the engine you are importing into.
        </p>
      </FieldRow>

      {options.preset === 'custom' ? (
        <FieldRow legend="AXIS AND UNITS" columns={1}>
          <Select<UpAxis>
            label="UP AXIS"
            value={options.upAxis}
            options={[
              { value: 'y', label: 'Y-UP' },
              { value: 'z', label: 'Z-UP' },
            ]}
            onChange={(upAxis) => setExportOptions({ upAxis })}
          />
          <Select<UnitPreset>
            label="UNITS"
            value={options.unit}
            options={[
              { value: 'meters', label: 'METERS' },
              { value: 'centimeters', label: 'CENTIMETERS' },
            ]}
            onChange={(unit) => setExportOptions({ unit })}
          />
          <NumberField
            label="SCALE"
            value={options.scale}
            step={0.1}
            min={0.0001}
            onChange={(scale) => setExportOptions({ scale })}
          />
        </FieldRow>
      ) : null}

      <FieldRow legend="GEOMETRY" columns={1}>
        <Toggle
          label="APPLY MODIFIERS"
          checked
          disabled
          onChange={() => {}}
        />
        <Toggle
          label="APPLY TRANSFORMS"
          checked={options.applyTransform}
          onChange={(applyTransform) => setExportOptions({ applyTransform })}
        />
        <Toggle
          label="TRIANGULATE"
          checked={options.triangulate}
          onChange={(triangulate) => setExportOptions({ triangulate })}
        />
        <Toggle
          label="PER-VERTEX NORMALS"
          checked={options.perVertexNormals}
          onChange={(perVertexNormals) => setExportOptions({ perVertexNormals })}
        />
        <Toggle
          label="INCLUDE UVS"
          checked={options.includeUVs}
          onChange={(includeUVs) => setExportOptions({ includeUVs })}
        />
        <Toggle label="SELECTION ONLY" checked={selectionOnly} onChange={setSelectionOnly} />
      </FieldRow>

      <p className="export-dialog__note">
        OBJ writes a matching .mtl alongside the mesh. FBX is ASCII 7.4, which Unity, Unreal,
        Blender, Maya and 3ds Max all import.
      </p>
    </Modal>
  );
}
