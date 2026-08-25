import type { Modifier, ModifierType } from '@kernel/index';
import { NumberField, Panel, Select, Toggle } from '@shared/components';
import { useTooltipTrigger } from '@shared/hooks/useTooltipTrigger';
import { useActiveObject, useEditorStore } from '@store/index';

import './ModifierStack.scss';

const MODIFIER_INFO: Record<ModifierType, { label: string; description: string }> = {
  mirror: {
    label: 'MIRROR',
    description:
      'Reflects the mesh across the object origin on each enabled axis. Merge welds the two halves into one surface where they meet the mirror plane.',
  },
  array: {
    label: 'ARRAY',
    description:
      'Repeats the mesh in a line. Each copy is offset by a fraction of the bounding box, a fixed distance, or both added together.',
  },
  solidify: {
    label: 'SOLIDIFY',
    description:
      'Gives a flat surface thickness by extruding a second shell along the vertex normals and closing the gap around open edges.',
  },
  weld: {
    label: 'WELD',
    description:
      'Fuses vertices closer together considering a DISTANCE threshold. Raising it starts collapsing real detail.',
  },
  subdivide: {
    label: 'SUBDIVISION',
    description:
      'Splits every face into smaller ones and pulls them toward the Catmull-Clark limit surface, rounding the shape off.',
  },
};

const MODIFIER_OPTIONS = (Object.keys(MODIFIER_INFO) as ModifierType[]).map((type) => ({
  value: type,
  label: MODIFIER_INFO[type].label,
}));

export function ModifierStack() {
  const object = useActiveObject();
  const addModifier = useEditorStore((state) => state.addModifier);
  const updateModifier = useEditorStore((state) => state.updateModifier);
  const removeModifier = useEditorStore((state) => state.removeModifier);
  const moveModifier = useEditorStore((state) => state.moveModifier);
  const applyModifier = useEditorStore((state) => state.applyModifierToMesh);

  if (!object) {
    return (
      <Panel title="MODIFIERS">
        <p className="modifiers__empty">Nothing selected.</p>
      </Panel>
    );
  }

  return (
    <Panel
      title="MODIFIERS"
      className="modifiers"
      actions={
        <Select
          label="Add modifier"
          hideLabel
          hint="Add a non-destructive modifier to the stack"
          value={'' as ModifierType | ''}
          options={[{ value: '' as const, label: '+ ADD' }, ...MODIFIER_OPTIONS]}
          onChange={(value) => {
            if (value) addModifier(value as ModifierType);
          }}
        />
      }
    >
      {object.modifiers.length === 0 ? (
        <p className="modifiers__empty">
          Stack is empty. Modifiers are non-destructive: the base mesh stays editable.
        </p>
      ) : (
        <ul className="modifiers__list">
          {object.modifiers.map((modifier, index) => (
            <li key={modifier.id} className="modifiers__item">
              <header className="modifiers__header">
                <span className="modifiers__name">{modifier.name}</span>
                <div className="modifiers__controls">
                  <ModifierIconButton
                    label={`Move ${modifier.name} up`}
                    hint="Move this modifier earlier in the stack"
                    disabled={index === 0}
                    onClick={() => moveModifier(modifier.id, -1)}
                  >
                    ▲
                  </ModifierIconButton>
                  <ModifierIconButton
                    label={`Move ${modifier.name} down`}
                    hint="Move this modifier later in the stack"
                    disabled={index === object.modifiers.length - 1}
                    onClick={() => moveModifier(modifier.id, 1)}
                  >
                    ▼
                  </ModifierIconButton>
                  <ModifierIconButton
                    label={`Apply ${modifier.name}`}
                    hint="Bake this modifier into the base mesh and remove it from the stack"
                    onClick={() => applyModifier(modifier.id)}
                  >
                    ✓
                  </ModifierIconButton>
                  <ModifierIconButton
                    label={`Remove ${modifier.name}`}
                    hint="Discard this modifier without applying it"
                    onClick={() => removeModifier(modifier.id)}
                  >
                    ✕
                  </ModifierIconButton>
                </div>
              </header>

              <div className="modifiers__body">
                <p className="modifiers__description">{MODIFIER_INFO[modifier.type].description}</p>
                <Toggle
                  label="ENABLED"
                  checked={modifier.enabled}
                  hint="Include this modifier when the mesh is displayed and exported"
                  onChange={(enabled) => updateModifier(modifier.id, { enabled })}
                />
                <ModifierFields
                  modifier={modifier}
                  onChange={(patch) => updateModifier(modifier.id, patch)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface ModifierIconButtonProps {
  label: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}

/** The stack's reorder/apply/remove glyphs are too small for Button/IconButton's layout. */
function ModifierIconButton({ label, hint, disabled, onClick, children }: ModifierIconButtonProps) {
  const tooltip = useTooltipTrigger(hint);
  return (
    <button
      type="button"
      aria-label={label}
      // See Button: the native attribute would take the hint down with it.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      {...tooltip}
    >
      {children}
    </button>
  );
}

interface ModifierFieldsProps {
  modifier: Modifier;
  onChange: (patch: Partial<Modifier>) => void;
}

function ModifierFields({ modifier, onChange }: ModifierFieldsProps) {
  if (modifier.type === 'mirror') {
    return (
      <>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <Toggle
            key={axis}
            label={`AXIS ${axis.toUpperCase()}`}
            checked={modifier.axes[axis]}
            hint={`Mirror geometry across the ${axis.toUpperCase()} axis`}
            onChange={(checked) => onChange({ axes: { ...modifier.axes, [axis]: checked } })}
          />
        ))}
        <Toggle
          label="MERGE"
          checked={modifier.merge}
          hint="Weld the seam where the mirrored halves meet"
          onChange={(merge) => onChange({ merge })}
        />
        <NumberField
          label="THRESHOLD"
          value={modifier.mergeThreshold}
          step={0.001}
          min={0}
          precision={4}
          hint="How close to the mirror plane a vertex must sit to absorb its own reflection"
          onChange={(mergeThreshold) => onChange({ mergeThreshold })}
        />
        <Toggle
          label="CLIPPING"
          checked={modifier.clipping}
          hint="Snap vertices within the threshold of the mirror plane onto it"
          onChange={(clipping) => onChange({ clipping })}
        />
        <Toggle
          label="BISECT"
          checked={modifier.bisect}
          hint="Cut the mesh at the mirror plane and keep only the positive half"
          onChange={(bisect) => onChange({ bisect })}
        />
      </>
    );
  }

  if (modifier.type === 'array') {
    return (
      <>
        <NumberField
          label="COUNT"
          value={modifier.count}
          integer
          min={1}
          max={128}
          hint="How many copies to place, including the original"
          onChange={(count) => onChange({ count })}
        />
        <Toggle
          label="RELATIVE"
          checked={modifier.useRelative}
          hint="Offset each copy as a fraction of the mesh's own bounding box"
          onChange={(useRelative) => onChange({ useRelative })}
        />
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField
            key={`relative-${axis}`}
            label={`REL ${axis.toUpperCase()}`}
            value={modifier.relativeOffset[axis]}
            step={0.1}
            disabled={!modifier.useRelative}
            hint={`Relative offset per copy along ${axis.toUpperCase()}`}
            onChange={(value) =>
              onChange({ relativeOffset: { ...modifier.relativeOffset, [axis]: value } })
            }
          />
        ))}
        <Toggle
          label="CONSTANT"
          checked={modifier.useConstant}
          hint="Offset each copy by a fixed distance, on top of the relative offset"
          onChange={(useConstant) => onChange({ useConstant })}
        />
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField
            key={`constant-${axis}`}
            label={`CONST ${axis.toUpperCase()}`}
            value={modifier.constantOffset[axis]}
            step={0.1}
            disabled={!modifier.useConstant}
            hint={`Constant offset per copy along ${axis.toUpperCase()}`}
            onChange={(value) =>
              onChange({ constantOffset: { ...modifier.constantOffset, [axis]: value } })
            }
          />
        ))}
        <Toggle
          label="MERGE"
          checked={modifier.merge}
          hint="Weld vertices where consecutive copies touch"
          onChange={(merge) => onChange({ merge })}
        />
      </>
    );
  }

  if (modifier.type === 'solidify') {
    return (
      <>
        <NumberField
          label="THICKNESS"
          value={modifier.thickness}
          step={0.01}
          hint="How far to extrude the shell along vertex normals"
          onChange={(thickness) => onChange({ thickness })}
        />
        <Toggle
          label="EVEN OFFSET"
          checked={modifier.evenOffset}
          hint="Split the thickness evenly to either side of the surface"
          onChange={(evenOffset) => onChange({ evenOffset })}
        />
        <Toggle
          label="RIM FILL"
          checked={modifier.rimFill}
          hint="Close the open edge of the shell with rim faces"
          onChange={(rimFill) => onChange({ rimFill })}
        />
      </>
    );
  }

  if (modifier.type === 'weld') {
    return (
      <NumberField
        label="DISTANCE"
        value={modifier.threshold}
        step={0.001}
        min={0}
        precision={4}
        hint="How far apart two vertices can sit and still be fused into one"
        onChange={(threshold) => onChange({ threshold })}
      />
    );
  }

  return (
    <>
      <NumberField
        label="LEVELS"
        value={modifier.levels}
        integer
        min={0}
        max={3}
        hint="How many Catmull-Clark subdivision passes to apply"
        onChange={(levels) => onChange({ levels })}
      />
      <NumberField
        label="SMOOTH"
        value={modifier.smooth}
        step={0.1}
        min={0}
        max={1}
        hint="Blend toward the limit surface versus the flat cage"
        onChange={(smooth) => onChange({ smooth })}
      />
    </>
  );
}
