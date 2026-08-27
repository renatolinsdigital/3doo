import { REMESH_PRESETS } from '@kernel/index';
import { Button, FieldRow, Panel } from '@shared/components';
import { useEditorStore } from '@store/index';

/**
 * Named starting points for the remesh settings.
 *
 * Retopology is a question of what the mesh is *for* — an engine, a sculpt, a
 * block-out — far more than of any single slider, so the presets say it in
 * those terms and then leave every control below open to adjust.
 */
export function RemeshPresetPanel() {
  const applyPreset = useEditorStore((state) => state.applyRemeshPreset);

  return (
    <Panel title="PRESETS">
      <FieldRow columns={2}>
        {REMESH_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            label={preset.label}
            hint={preset.hint}
            onClick={() => applyPreset(preset.id)}
          />
        ))}
      </FieldRow>
    </Panel>
  );
}
