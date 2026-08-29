import { useState } from 'react';

import { Button, FieldRow, NumberField, Panel, Toggle } from '@shared/components';
import { useActiveSelectionCounts, useEditorStore } from '@store/index';

/**
 * The edit-mode operators that add geometry, with their parameters.
 *
 * Parameters live in local state and are passed to `exec`, so each run is one
 * undo step with the values the user actually chose. What each operator does to
 * the surrounding topology — welding, filling, cleaning up — sits next door in
 * `TopologyPanel`, and the ones that follow an edge loop in
 * `LoopOperationsPanel`, so a parameterised operator is never buried among
 * buttons that take none.
 */
export function OperationsPanel() {
  const exec = useEditorStore((state) => state.exec);

  // Every operator below refuses outright when the selection cannot feed it —
  // the button is disabled to match, and its hint says what to select instead.
  const selection = useActiveSelectionCounts();

  const [extrudeOffset, setExtrudeOffset] = useState(1);
  const [extrudeIndividual, setExtrudeIndividual] = useState(false);
  const [insetThickness, setInsetThickness] = useState(0.2);
  const [insetDepth, setInsetDepth] = useState(0);
  const [bevelWidth, setBevelWidth] = useState(0.2);
  const [bevelSegments, setBevelSegments] = useState(1);

  return (
    <Panel title="OPERATIONS">
      <FieldRow legend="EXTRUDE" columns={1}>
        <NumberField
          label="OFFSET"
          value={extrudeOffset}
          step={0.1}
          hint="Distance to push the new geometry along the normal"
          onChange={setExtrudeOffset}
        />
        <Toggle
          label="INDIVIDUAL"
          checked={extrudeIndividual}
          hint="Extrude each selected face along its own normal"
          onChange={setExtrudeIndividual}
        />
        <Button
          label="EXTRUDE"
          variant="primary"
          disabled={selection.faces === 0 && selection.edges === 0}
          hint={
            selection.faces > 0 || selection.edges > 0
              ? 'Pull the selected faces or edges out into new geometry (E)'
              : 'Select faces or edges to pull out into new geometry (E)'
          }
          onClick={() =>
            exec('extrude', { offset: extrudeOffset, individual: extrudeIndividual }, 'Extrude')
          }
        />
      </FieldRow>

      <FieldRow legend="INSET" columns={1}>
        <NumberField
          label="THICKNESS"
          value={insetThickness}
          step={0.05}
          min={0}
          hint="Width of the border ring left around the inset face"
          onChange={setInsetThickness}
        />
        <NumberField
          label="DEPTH"
          value={insetDepth}
          step={0.05}
          hint="Push the inset face along the normal while insetting"
          onChange={setInsetDepth}
        />
        <Button
          label="INSET"
          disabled={selection.faces === 0}
          hint={
            selection.faces > 0
              ? 'Shrink the selected faces inward, keeping the border (I)'
              : 'Insetting shrinks faces inward — select some first (I)'
          }
          onClick={() => exec('inset', { thickness: insetThickness, depth: insetDepth }, 'Inset')}
        />
      </FieldRow>

      <FieldRow legend="BEVEL" columns={1}>
        <NumberField
          label="WIDTH"
          value={bevelWidth}
          step={0.02}
          min={0}
          hint="How far the chamfer eats into the adjacent faces"
          onChange={setBevelWidth}
        />
        <NumberField
          label="SEGMENTS"
          value={bevelSegments}
          integer
          min={1}
          max={12}
          hint="More segments round the chamfer instead of leaving it flat"
          onChange={setBevelSegments}
        />
        <Button
          label="BEVEL"
          disabled={selection.edges === 0}
          hint={
            selection.edges > 0
              ? 'Chamfer the selected edges (Ctrl+B)'
              : 'Bevelling chamfers edges — select some first (Ctrl+B)'
          }
          onClick={() => exec('bevel', { width: bevelWidth, segments: bevelSegments }, 'Bevel')}
        />
      </FieldRow>
    </Panel>
  );
}
