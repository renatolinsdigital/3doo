import { useState } from 'react';
import { createPortal } from 'react-dom';

import {
  INTEGER_PARAMS,
  METRE_PARAMS,
  PRIMITIVE_FIELDS,
  type PrimitiveParams,
  radToDeg,
  degToRad,
  vec3,
} from '@kernel/index';
import {
  type ContextMenuEntry,
  Button,
  ContextMenu,
  FieldRow,
  NumberField,
  Panel,
  TextField,
  Toggle,
  Vector3Field,
} from '@shared/components';
import { useTooltipTrigger } from '@shared/hooks/useTooltipTrigger';
import { cx } from '@shared/utils/cx';
import { useActiveObject, useEditorStore } from '@store/index';

import './PropertiesPanel.scss';

/**
 * Decimal places the transform rows show and round a typed entry to.
 *
 * A gizmo drag lands on values with the full float behind them, and reading
 * back sixteen digits of it says nothing anyone can act on. Six is a micrometre
 * at these scales: fine enough to type an exact figure into, short enough to
 * read. The store keeps whatever the drag produced.
 */
const TRANSFORM_PRECISION = 6;

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
  const removeMaterial = useEditorStore((state) => state.removeMaterial);
  const exec = useEditorStore((state) => state.exec);

  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [slotMenu, setSlotMenu] = useState<{ slot: number; x: number; y: number } | null>(null);

  if (!object) {
    return (
      <Panel title="PROPERTIES">
        <p className="properties__empty">Nothing selected.</p>
      </Panel>
    );
  }

  const { transform } = object;
  const locked = object.locked ? 'Unlock this object in the outliner to edit its transform' : null;
  // Converted but not rounded: the field rounds what it shows, and editing one
  // axis writes the other two back untouched. Rounding here instead would let
  // a nudge to X quietly quantize Y and Z along with it.
  const degrees = vec3(
    radToDeg(transform.rotation.x),
    radToDeg(transform.rotation.y),
    radToDeg(transform.rotation.z),
  );

  const menuMaterial = slotMenu ? (object.materials[slotMenu.slot] ?? null) : null;

  // Every entry names the row the menu was opened on rather than the active
  // slot, the same way the outliner's row menu does.
  const slotEntries = (slot: number): ContextMenuEntry[] => [
    {
      id: 'rename',
      label: 'RENAME',
      hint: 'Edit the slot name in place (double-click it)',
      onSelect: () => setEditingSlot(slot),
    },
    { id: 'rule', separator: true },
    {
      id: 'delete',
      label: 'DELETE',
      hint: 'Remove this slot; faces wearing it fall back to the first',
      onSelect: () => removeMaterial(slot),
    },
  ];

  return (
    <Panel title="PROPERTIES" className="properties">
      <Vector3Field
        legend="LOCATION"
        value={transform.position}
        step={0.1}
        precision={TRANSFORM_PRECISION}
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
        precision={TRANSFORM_PRECISION}
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
        precision={TRANSFORM_PRECISION}
        disabled={object.locked}
        hint={(axis) =>
          locked ??
          `Scale multiplier along the ${axis.toUpperCase()} axis. 1 keeps the modelled size`
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
              isEditing={editingSlot === index}
              onSelect={() => setActiveMaterial(index)}
              onColorChange={(color) => updateMaterial(index, { color })}
              onStartRename={() => setEditingSlot(index)}
              onFinishRename={(name) => {
                updateMaterial(index, { name });
                setEditingSlot(null);
              }}
              onCancelRename={() => setEditingSlot(null)}
              onOpenMenu={(x, y) => setSlotMenu({ slot: index, x, y })}
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
        {slotMenu && menuMaterial
          ? // Portalled for the reason the outliner's is: the right-hand column
            // scrolls and clips, so a menu drawn inside it would be cut off.
            createPortal(
              <ContextMenu
                x={slotMenu.x}
                y={slotMenu.y}
                label={menuMaterial.name}
                entries={slotEntries(slotMenu.slot)}
                onClose={() => setSlotMenu(null)}
              />,
              document.body,
            )
          : null}
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
  isEditing: boolean;
  onSelect: () => void;
  onColorChange: (color: { r: number; g: number; b: number }) => void;
  onStartRename: () => void;
  onFinishRename: (name: string) => void;
  onCancelRename: () => void;
  /** Opens the row's menu at the pointer, in client coordinates. */
  onOpenMenu: (x: number, y: number) => void;
}

function MaterialRow({
  name,
  active,
  color,
  isEditing,
  onSelect,
  onColorChange,
  onStartRename,
  onFinishRename,
  onCancelRename,
  onOpenMenu,
}: MaterialRowProps) {
  const slotTooltip = useTooltipTrigger(
    'Click to make this the active slot for Assign, double-click to rename, right-click for more',
  );
  const swatchTooltip = useTooltipTrigger(`${name} colour`);

  return (
    <li
      className="properties__material"
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(event.clientX, event.clientY);
      }}
    >
      {isEditing ? (
        <TextField
          label={`Rename ${name}`}
          defaultValue={name}
          autoFocus
          onBlur={(event) => onFinishRename(event.target.value.trim() || name)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') onCancelRename();
          }}
        />
      ) : (
        <button
          type="button"
          className={cx('properties__material-slot', active && 'properties__material-slot--active')}
          aria-pressed={active}
          onClick={onSelect}
          onDoubleClick={onStartRename}
          {...slotTooltip}
        >
          {name}
        </button>
      )}
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
