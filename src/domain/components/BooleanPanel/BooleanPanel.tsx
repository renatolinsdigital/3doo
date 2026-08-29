import { useShallow } from 'zustand/react/shallow';

import { Button, FieldRow, Panel } from '@shared/components';
import { activeObject, useEditorStore } from '@store/index';

/**
 * Boolean operations between whole objects.
 *
 * The active object is the one that keeps the result; everything else in the
 * selection is a cutter and is consumed. That reads the same way MERGE
 * SELECTED does, so the rule for "which object survives" is one rule.
 */
export function BooleanPanel() {
  const booleanWithSelected = useEditorStore((state) => state.booleanWithSelected);
  const active = useEditorStore(activeObject);
  const tools = useEditorStore(
    (state) => state.selectedObjectIds.filter((id) => id !== state.activeObjectId).length,
  );
  const busy = useEditorStore((state) => state.busy);
  // Named rather than counted, so the hint can say which object is holding
  // things up. The buttons stay live: clicking is how the toast gets said,
  // and a dead button explains nothing.
  const unapplied = useEditorStore(
    useShallow((state) =>
      state.objects
        .filter(
          (object) =>
            (object.id === state.activeObjectId ||
              state.selectedObjectIds.includes(object.id)) &&
            object.modifiers.some((modifier) => modifier.enabled),
        )
        .map((object) => object.name),
    ),
  );

  // Every operation needs the same two things, so they share one explanation
  // of what is missing rather than each guessing at it.
  const ready = active !== null && tools > 0 && !busy;
  const missing = !active
    ? 'Select two objects: the last one clicked keeps the result'
    : `Select a cutter as well; ${active.name} keeps the result`;

  const hint = (available: string) =>
    busy
      ? 'A boolean is already running: the status bar shows how far along it is'
      : unapplied.length > 0
        ? `Apply the modifiers on ${unapplied.join(', ')} first: a boolean cuts the mesh underneath the stack`
        : ready
          ? `${available} (${active.name} keeps it)`
          : missing;

  return (
    <Panel title="BOOLEAN">
      <FieldRow columns={1}>
        <Button
          label="UNION"
          disabled={!ready}
          hint={hint('Fuse the selected objects into one solid')}
          onClick={() => booleanWithSelected('union')}
        />
        <Button
          label="DIFFERENCE"
          disabled={!ready}
          hint={hint('Cut the other selected objects out of the active one')}
          onClick={() => booleanWithSelected('difference')}
        />
        <Button
          label="INTERSECT"
          disabled={!ready}
          hint={hint('Keep only the solid the selected objects share')}
          onClick={() => booleanWithSelected('intersect')}
        />
      </FieldRow>
    </Panel>
  );
}
