import {
  INTEGER_PARAMS,
  METRE_PARAMS,
  PRIMITIVE_FIELDS,
  type PrimitiveParams,
  radToDeg,
  degToRad,
  vec3,
} from '@kernel/index';
import { Button, FieldRow, NumberField, Panel, Toggle, Vector3Field } from '@shared/components';
import { useTooltipTrigger } from '@shared/hooks/useTooltipTrigger';
import { cx } from '@shared/utils/cx';
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

// Lengths say metres outright: the value carries an "m" beside it, but the
// hint is what gets read when a number's meaning is not obvious.
const PARAM_HINTS: Record<keyof PrimitiveParams, string> = {
  size: 'Overall edge length of the shape, in metres',
  radius: 'Distance from the centre to the surface, in metres',
  radius2: 'Radius of the tube swept around the ring, in metres',
  height: 'Distance from base to tip along the local Y axis, in metres',
  segments: 'Number of divisions around the shape',
  rings: 'Number of divisions from pole to pole, or around the tube',
  subdivisions: 'How many times to split the base icosahedron',
  capFill: 'Fill the open ends with a face instead of leaving them open',
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
  const locked = object.locked ? 'Unlock this object in the outliner to edit its transform' : null;
  const degrees = vec3(
    Number(radToDeg(transform.rotation.x).toFixed(2)),
    Number(radToDeg(transform.rotation.y).toFixed(2)),
    Number(radToDeg(transform.rotation.z).toFixed(2)),
  );

  return (
    <Panel title="PROPERTIES" className="properties">
      <Vector3Field
        legend="LOCATION"
        value={transform.position}
        step={0.1}
        suffix="m"
        disabled={object.locked}
        hint={(axis) =>
          locked ?? `World-space ${axis.toUpperCase()} position in metres; drag the label to scrub`
        }
        onChange={(position) => setObjectTransform(object.id, { position })}
      />

      <Vector3Field
        legend="ROTATION"
        value={degrees}
        step={1}
        suffix="°"
        disabled={object.locked}
        hint={(axis) => locked ?? `Rotation around the ${axis.toUpperCase()} axis, in degrees`}
        onChange={(next) =>
          setObjectTransform(object.id, {
            rotation: vec3(degToRad(next.x), degToRad(next.y), degToRad(next.z)),
          })
        }
      />

      <Vector3Field
        legend="SCALE"
        value={transform.scale}
        step={0.05}
        disabled={object.locked}
        hint={(axis) =>
          locked ??
          `Scale multiplier along the ${axis.toUpperCase()} axis — 1 keeps the modelled size`
        }
        onChange={(scale) => setObjectTransform(object.id, { scale })}
      />

      {object.primitive ? (
        <FieldRow legend={`${object.primitive.kind.toUpperCase()} PARAMETERS`} columns={1}>
          {PRIMITIVE_FIELDS[object.primitive.kind].map((field) =>
            field === 'capFill' ? (
              <Toggle
                key={field}
                label={PARAM_LABELS[field]}
                checked={object.primitive?.params.capFill ?? true}
                hint={PARAM_HINTS[field]}
                onChange={(checked) => updatePrimitiveParams({ capFill: checked })}
              />
            ) : (
              <NumberField
                key={field}
                label={PARAM_LABELS[field]}
                value={object.primitive?.params[field] as number}
                integer={INTEGER_PARAMS.has(field)}
                suffix={METRE_PARAMS.has(field) ? 'm' : undefined}
                min={field === 'segments' || field === 'rings' ? 3 : 0}
                hint={PARAM_HINTS[field]}
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
            <MaterialRow
              key={material.id}
              name={material.name}
              active={index === object.activeMaterial}
              color={material.color}
              onSelect={() => setActiveMaterial(index)}
              onColorChange={(color) => updateMaterial(index, { color })}
            />
          ))}
        </ul>
        <div className="properties__material-actions">
          <Button
            label="ADD SLOT"
            variant="secondary"
            hint="Add another material slot to this object"
            onClick={addMaterial}
          />
          <Button
            label="ASSIGN"
            variant="secondary"
            disabled={mode !== 'edit'}
            hint="Assign the active material slot to the selected faces"
            onClick={assignMaterial}
          />
        </div>
      </FieldRow>

      {mode === 'edit' ? (
        <FieldRow legend="NORMALS" columns={2}>
          <Button
            label="RECALC"
            hint="Make winding consistent and point normals outward (Shift+N)"
            onClick={() => exec('recalculateNormals', { outside: true }, 'Recalculate normals')}
          />
          <Button
            label="FLIP"
            hint="Reverse the winding of the selected (or all) faces"
            onClick={() => exec('flipNormals', {}, 'Flip normals')}
          />
          <Button
            label="SHADE SMOOTH"
            hint="Interpolate normals across faces for a rounded look"
            onClick={() => exec('shade', { smooth: true }, 'Shade smooth')}
          />
          <Button
            label="SHADE FLAT"
            hint="Use one flat normal per face"
            onClick={() => exec('shade', { smooth: false }, 'Shade flat')}
          />
        </FieldRow>
      ) : null}
    </Panel>
  );
}

interface MaterialRowProps {
  name: string;
  active: boolean;
  color: { r: number; g: number; b: number };
  onSelect: () => void;
  onColorChange: (color: { r: number; g: number; b: number }) => void;
}

function MaterialRow({ name, active, color, onSelect, onColorChange }: MaterialRowProps) {
  const slotTooltip = useTooltipTrigger('Make this the active material slot for Assign');
  const swatchTooltip = useTooltipTrigger(`${name} colour`);

  return (
    <li className="properties__material">
      <button
        type="button"
        className={cx('properties__material-slot', active && 'properties__material-slot--active')}
        aria-pressed={active}
        onClick={onSelect}
        {...slotTooltip}
      >
        {name}
      </button>
      <input
        className="properties__swatch"
        type="color"
        aria-label={`${name} colour`}
        value={toHex(color)}
        onChange={(event) => onColorChange(fromHex(event.target.value))}
        {...swatchTooltip}
      />
    </li>
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
