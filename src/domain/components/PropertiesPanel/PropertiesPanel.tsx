import {
  PRIMITIVE_FIELDS,
  type PrimitiveParams,
  radToDeg,
  degToRad,
} from '@kernel/index';
import { Button, FieldRow, NumberField, Panel, Toggle } from '@shared/components';
import { useActiveObject, useEditorStore } from '@store/index';

import './PropertiesPanel.scss';

const PARAM_LABELS: Record<keyof PrimitiveParams, string> = {
  size: 'SIZE',
  radius: 'RADIUS',
  radius2: 'TUBE',
  height: 'HEIGHT',
  segments: 'SEGMENTS',
  rings: 'RINGS',
  subdivisions: 'SUBDIV',
  capFill: 'CAPS',
};

export function PropertiesPanel() {
  const object = useActiveObject();
  const mode = useEditorStore((state) => state.mode);
  const setObjectTransform = useEditorStore((state) => state.setObjectTransform);
  const updatePrimitiveParams = useEditorStore((state) => state.updatePrimitiveParams);
  const addMaterial = useEditorStore((state) => state.addMaterial);
  const updateMaterial = useEditorStore((state) => state.updateMaterial);
  const setActiveMaterial = useEditorStore((state) => state.setActiveMaterial);
  const assignMaterial = useEditorStore((state) => state.assignMaterialToSelection);
  const exec = useEditorStore((state) => state.exec);

  if (!object) {
    return (
      <Panel title="PROPERTIES">
        <p className="properties__empty">Nothing selected.</p>
      </Panel>
    );
  }

  const { transform } = object;

  return (
    <Panel title="PROPERTIES" className="properties">
      <FieldRow legend="LOCATION" columns={1}>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField
            key={`position-${axis}`}
            label={axis.toUpperCase()}
            value={transform.position[axis]}
            step={0.1}
            onChange={(value) =>
              setObjectTransform(object.id, {
                position: { ...transform.position, [axis]: value },
              })
            }
          />
        ))}
      </FieldRow>

      <FieldRow legend="ROTATION" columns={1}>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField
            key={`rotation-${axis}`}
            label={axis.toUpperCase()}
            value={Number(radToDeg(transform.rotation[axis]).toFixed(2))}
            step={1}
            suffix="°"
            onChange={(value) =>
              setObjectTransform(object.id, {
                rotation: { ...transform.rotation, [axis]: degToRad(value) },
              })
            }
          />
        ))}
      </FieldRow>

      <FieldRow legend="SCALE" columns={1}>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField
            key={`scale-${axis}`}
            label={axis.toUpperCase()}
            value={transform.scale[axis]}
            step={0.05}
            onChange={(value) =>
              setObjectTransform(object.id, {
                scale: { ...transform.scale, [axis]: value },
              })
            }
          />
        ))}
      </FieldRow>

      {object.primitive ? (
        <FieldRow legend={`${object.primitive.kind.toUpperCase()} PARAMETERS`} columns={1}>
          {PRIMITIVE_FIELDS[object.primitive.kind].map((field) =>
            field === 'capFill' ? (
              <Toggle
                key={field}
                label={PARAM_LABELS[field]}
                checked={object.primitive?.params.capFill ?? true}
                onChange={(checked) => updatePrimitiveParams({ capFill: checked })}
              />
            ) : (
              <NumberField
                key={field}
                label={PARAM_LABELS[field]}
                value={object.primitive?.params[field] as number}
                step={field === 'segments' || field === 'rings' || field === 'subdivisions' ? 1 : 0.1}
                min={field === 'segments' || field === 'rings' ? 3 : 0}
                onChange={(value) => updatePrimitiveParams({ [field]: value })}
              />
            ),
          )}
          <p className="properties__hint">
            Parameters stay live until the next modelling operation commits.
          </p>
        </FieldRow>
      ) : null}

      <FieldRow legend="MATERIALS" columns={1}>
        <ul className="properties__materials">
          {object.materials.map((material, index) => (
            <li key={material.id} className="properties__material">
              <button
                type="button"
                className={`properties__material-slot${
                  index === object.activeMaterial ? ' properties__material-slot--active' : ''
                }`}
                aria-pressed={index === object.activeMaterial}
                onClick={() => setActiveMaterial(index)}
              >
                {material.name}
              </button>
              <input
                className="properties__swatch"
                type="color"
                aria-label={`${material.name} colour`}
                value={toHex(material.color)}
                onChange={(event) =>
                  updateMaterial(index, { color: fromHex(event.target.value) })
                }
              />
            </li>
          ))}
        </ul>
        <div className="properties__material-actions">
          <Button label="ADD SLOT" variant="secondary" onClick={addMaterial} />
          <Button
            label="ASSIGN"
            variant="secondary"
            disabled={mode !== 'edit'}
            onClick={assignMaterial}
          />
        </div>
      </FieldRow>

      {mode === 'edit' ? (
        <FieldRow legend="NORMALS" columns={2}>
          <Button
            label="RECALC"
            onClick={() => exec('recalculateNormals', { outside: true }, 'Recalculate normals')}
          />
          <Button label="FLIP" onClick={() => exec('flipNormals', {}, 'Flip normals')} />
          <Button label="SHADE SMOOTH" onClick={() => exec('shade', { smooth: true }, 'Shade smooth')} />
          <Button label="SHADE FLAT" onClick={() => exec('shade', { smooth: false }, 'Shade flat')} />
        </FieldRow>
      ) : null}
    </Panel>
  );
}

function toHex(color: { r: number; g: number; b: number }): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function fromHex(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  };
}
