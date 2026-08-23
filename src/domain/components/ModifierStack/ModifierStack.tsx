import type { Modifier, ModifierType } from '@kernel/index';
import { NumberField, Panel, Select, Toggle } from '@shared/components';
import { useActiveObject, useEditorStore } from '@store/index';

import './ModifierStack.scss';

const MODIFIER_OPTIONS = [
  { value: 'mirror', label: 'MIRROR' },
  { value: 'array', label: 'ARRAY' },
  { value: 'solidify', label: 'SOLIDIFY' },
  { value: 'weld', label: 'WELD' },
  { value: 'subdivide', label: 'SUBDIVISION' },
] as const;

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
                  <button
                    type="button"
                    aria-label={`Move ${modifier.name} up`}
                    disabled={index === 0}
                    onClick={() => moveModifier(modifier.id, -1)}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${modifier.name} down`}
                    disabled={index === object.modifiers.length - 1}
                    onClick={() => moveModifier(modifier.id, 1)}
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    aria-label={`Apply ${modifier.name}`}
                    onClick={() => applyModifier(modifier.id)}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${modifier.name}`}
                    onClick={() => removeModifier(modifier.id)}
                  >
                    ✕
                  </button>
                </div>
              </header>

              <div className="modifiers__body">
                <Toggle
                  label="ENABLED"
                  checked={modifier.enabled}
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
            onChange={(checked) => onChange({ axes: { ...modifier.axes, [axis]: checked } })}
          />
        ))}
        <Toggle
          label="MERGE"
          checked={modifier.merge}
          onChange={(merge) => onChange({ merge })}
        />
        <NumberField
          label="THRESHOLD"
          value={modifier.mergeThreshold}
          step={0.001}
          min={0}
          precision={4}
          onChange={(mergeThreshold) => onChange({ mergeThreshold })}
        />
        <Toggle
          label="CLIPPING"
          checked={modifier.clipping}
          onChange={(clipping) => onChange({ clipping })}
        />
        <Toggle
          label="BISECT"
          checked={modifier.bisect}
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
          step={1}
          min={1}
          max={128}
          precision={0}
          onChange={(count) => onChange({ count: Math.round(count) })}
        />
        <Toggle
          label="RELATIVE"
          checked={modifier.useRelative}
          onChange={(useRelative) => onChange({ useRelative })}
        />
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField
            key={`relative-${axis}`}
            label={`REL ${axis.toUpperCase()}`}
            value={modifier.relativeOffset[axis]}
            step={0.1}
            disabled={!modifier.useRelative}
            onChange={(value) =>
              onChange({ relativeOffset: { ...modifier.relativeOffset, [axis]: value } })
            }
          />
        ))}
        <Toggle
          label="CONSTANT"
          checked={modifier.useConstant}
          onChange={(useConstant) => onChange({ useConstant })}
        />
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField
            key={`constant-${axis}`}
            label={`CONST ${axis.toUpperCase()}`}
            value={modifier.constantOffset[axis]}
            step={0.1}
            disabled={!modifier.useConstant}
            onChange={(value) =>
              onChange({ constantOffset: { ...modifier.constantOffset, [axis]: value } })
            }
          />
        ))}
        <Toggle label="MERGE" checked={modifier.merge} onChange={(merge) => onChange({ merge })} />
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
          onChange={(thickness) => onChange({ thickness })}
        />
        <Toggle
          label="EVEN OFFSET"
          checked={modifier.evenOffset}
          onChange={(evenOffset) => onChange({ evenOffset })}
        />
        <Toggle
          label="RIM FILL"
          checked={modifier.rimFill}
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
        onChange={(threshold) => onChange({ threshold })}
      />
    );
  }

  return (
    <>
      <NumberField
        label="LEVELS"
        value={modifier.levels}
        step={1}
        min={0}
        max={3}
        precision={0}
        onChange={(levels) => onChange({ levels: Math.round(levels) })}
      />
      <NumberField
        label="SMOOTH"
        value={modifier.smooth}
        step={0.1}
        min={0}
        max={1}
        onChange={(smooth) => onChange({ smooth })}
      />
    </>
  );
}
