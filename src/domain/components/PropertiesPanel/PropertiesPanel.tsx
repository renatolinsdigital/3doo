import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  INTEGER_PARAMS,
  METRE_PARAMS,
  MIN_OBJECT_SIZE,
  PRIMITIVE_FIELDS,
  type PrimitiveParams,
  pivotReorient,
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
  RenameField,
  Toggle,
  Vector3Field,
} from '@shared/components';
import { useTooltipTrigger } from '@shared/hooks/useTooltipTrigger';
import { cx } from '@shared/utils/cx';
import { useActiveObject, useEdgeLengthTarget, useEditorStore } from '@store/index';

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

/** The smallest each parameter may be dialled to. Lengths stop at the size floor. */
function paramMinimum(field: keyof PrimitiveParams): number {
  if (field === 'segments' || field === 'rings') return 3;
  return METRE_PARAMS.has(field) ? MIN_OBJECT_SIZE : 0;
}

/**
 * Decimals a parameter is typed and shown to.
 *
 * Lengths need four to reach `MIN_OBJECT_SIZE`: at the field's usual three a
 * tenth of a millimetre rounds to nothing on the way in, and the floor would
 * be a number nobody could actually enter.
 */
function paramPrecision(field: keyof PrimitiveParams): number | undefined {
  return METRE_PARAMS.has(field) ? 4 : undefined;
}

export function PropertiesPanel() {
  const object = useActiveObject();
  const mode = useEditorStore((state) => state.mode);
  const pivot = useEditorStore((state) => state.pivot);
  const cursor = useEditorStore((state) => state.cursor);
  const setObjectTransform = useEditorStore((state) => state.setObjectTransform);
  const updatePrimitiveParams = useEditorStore((state) => state.updatePrimitiveParams);
  const addMaterial = useEditorStore((state) => state.addMaterial);
  const updateMaterial = useEditorStore((state) => state.updateMaterial);
  const setActiveMaterial = useEditorStore((state) => state.setActiveMaterial);
  const assignMaterial = useEditorStore((state) => state.assignMaterialToSelection);
  const removeMaterial = useEditorStore((state) => state.removeMaterial);
  const exec = useEditorStore((state) => state.exec);
  const recordHistory = useEditorStore((state) => state.recordHistory);
  const discardHistory = useEditorStore((state) => state.discardHistory);

  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [slotMenu, setSlotMenu] = useState<{ slot: number; x: number; y: number } | null>(null);

  // The length field is seeded from whatever is selected, so it opens showing
  // the size that is actually there rather than a number from a past selection.
  // Edges of differing lengths report none, and the field keeps the last figure
  // typed into it: there is no single size to put in its place.
  const edgeTarget = useEdgeLengthTarget();
  const [edgeLength, setEdgeLength] = useState(1);
  useEffect(() => {
    if (edgeTarget.length !== null) setEdgeLength(edgeTarget.length);
  }, [edgeTarget.length]);

  // Held while the LENGTH label is being dragged, with `applied` saying whether
  // the drag ever got as far as changing anything. A scrub sends a new value on
  // every pointer tick, and each one recording a step of its own would cost a
  // whole-scene snapshot per pixel and bury everything else in the timeline.
  const lengthScrub = useRef<{ applied: boolean } | null>(null);

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

  // Edges that meet are what rules the length field out, not how many there
  // are: see `useEdgeLengthTarget`.
  const edgeLengthReady = !object.locked && edgeTarget.edges > 0 && !edgeTarget.adjacent;
  const edgeLengthHint = object.locked
    ? 'Unlock this object in the outliner to edit its geometry'
    : edgeTarget.edges === 0
      ? 'Select the edge(s) to give an exact length to'
      : edgeTarget.adjacent
        ? 'Two of the selected edges meet at a vertex: sizing one would drag the other out of shape, so pick edge(s) that do not touch'
        : edgeTarget.length === null
          ? 'The selected edges differ in length, and what you type here gives every one of them that size'
          : 'Length the selected edge(s) are set to, in world metres. Both ends of each move, so an edge keeps its midpoint and its direction';

  /**
   * The typed or scrubbed length, straight onto the mesh.
   *
   * Mid-scrub the step to undo back to was taken when the drag began, so the
   * ticks in between record none of their own and the whole drag undoes as the
   * one change it reads as.
   */
  const applyEdgeLength = (length: number) => {
    setEdgeLength(length);
    if (!edgeLengthReady) return;

    const scrub = lengthScrub.current;
    exec('setEdgeLength', { length }, 'Set edge length', { record: scrub === null });
    if (scrub) scrub.applied = true;
  };

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
        hint={(axis) =>
          locked ??
          `Rotation around the ${axis.toUpperCase()} axis, in degrees${
            pivot === 'cursor' ? ', turning about the 3D cursor' : ''
          }`
        }
        onChange={(next) => {
          const rotation = vec3(degToRad(next.x), degToRad(next.y), degToRad(next.z));
          // The pivot decides what a turn is measured about whether it was
          // dragged off the gizmo or typed here. About the 3D cursor the origin
          // swings round it, so the position travels with the turn rather than
          // the object spinning where it stands, metres from the handles.
          const position =
            pivot === 'cursor'
              ? pivotReorient(transform.position, cursor, transform.rotation, rotation)
              : transform.position;

          setObjectTransform(object.id, { rotation, position });
        }}
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

      {mode === 'edit' ? (
        <FieldRow legend="SELECTED EDGE(S)" columns={1}>
          <NumberField
            label="LENGTH"
            value={edgeLength}
            step={0.05}
            min={MIN_OBJECT_SIZE}
            precision={4}
            suffix="m"
            disabled={!edgeLengthReady}
            hint={edgeLengthHint}
            onChange={applyEdgeLength}
            onScrubStart={() => {
              if (!edgeLengthReady) return;
              recordHistory('Set edge length');
              lengthScrub.current = { applied: false };
            }}
            onScrubEnd={() => {
              // A press that never travelled changed nothing, so the step it
              // reserved goes back rather than standing as an empty undo.
              if (lengthScrub.current && !lengthScrub.current.applied) discardHistory();
              lengthScrub.current = null;
            }}
          />
        </FieldRow>
      ) : null}

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
                min={paramMinimum(field)}
                precision={paramPrecision(field)}
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
        <RenameField name={name} onRename={onFinishRename} onCancel={onCancelRename} />
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
