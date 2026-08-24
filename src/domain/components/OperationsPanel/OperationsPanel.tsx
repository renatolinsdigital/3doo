import { useState } from 'react';

import { Button, FieldRow, NumberField, Panel, Select, Toggle } from '@shared/components';
import { useEditorStore } from '@store/index';

import './OperationsPanel.scss';

const MERGE_MODES = [
  { value: 'center', label: 'AT CENTER' },
  { value: 'last', label: 'AT LAST' },
  { value: 'first', label: 'AT FIRST' },
] as const;

/**
 * Edit-mode operators with their parameters.
 *
 * Parameters live in local state and are passed to `exec`, so each run is one
 * undo step with the values the user actually chose.
 */
export function OperationsPanel() {
  const exec = useEditorStore((state) => state.exec);
  const openDialog = useEditorStore((state) => state.openDialog);
  const proportional = useEditorStore((state) => state.proportional);
  const setProportional = useEditorStore((state) => state.setProportional);
  // Merging welds vertices together, so it has nothing to act on in the other
  // two select modes.
  const vertexMode = useEditorStore((state) => state.selectMode === 'vertex');

  const [extrudeOffset, setExtrudeOffset] = useState(1);
  const [extrudeIndividual, setExtrudeIndividual] = useState(false);
  const [insetThickness, setInsetThickness] = useState(0.2);
  const [insetDepth, setInsetDepth] = useState(0);
  const [bevelWidth, setBevelWidth] = useState(0.2);
  const [bevelSegments, setBevelSegments] = useState(1);
  const [loopCuts, setLoopCuts] = useState(1);
  const [subdivideCuts, setSubdivideCuts] = useState(1);
  const [subdivideSmooth, setSubdivideSmooth] = useState(0);
  const [mergeMode, setMergeMode] = useState<(typeof MERGE_MODES)[number]['value']>('center');

  return (
    <Panel title="OPERATIONS" className="operations">
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
          hint="Pull the selected faces or edges out into new geometry (E)"
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
          hint="Shrink the selected faces inward, keeping the border (I)"
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
          hint="Chamfer the selected edges (Ctrl+B)"
          onClick={() =>
            exec('bevel', { width: bevelWidth, segments: bevelSegments }, 'Bevel')
          }
        />
      </FieldRow>

      <FieldRow legend="LOOP CUT" columns={1}>
        <NumberField
          label="CUTS"
          value={loopCuts}
          integer
          min={1}
          max={32}
          hint="How many evenly spaced loops to insert at once"
          onChange={setLoopCuts}
        />
        <Button
          label="LOOP CUT"
          hint="Insert a new edge loop across the selected edge's quad ring (Ctrl+R)"
          onClick={() => exec('loopCut', { cuts: loopCuts }, 'Loop cut')}
        />
      </FieldRow>

      <FieldRow legend="SUBDIVIDE" columns={1}>
        <NumberField
          label="CUTS"
          value={subdivideCuts}
          integer
          min={1}
          max={4}
          hint="How many times to split each selected face"
          onChange={setSubdivideCuts}
        />
        <NumberField
          label="SMOOTH"
          value={subdivideSmooth}
          step={0.1}
          min={0}
          max={1}
          hint="Blend toward the Catmull-Clark limit surface"
          onChange={setSubdivideSmooth}
        />
        <Button
          label="SUBDIVIDE"
          hint="Split each selected face into four smaller faces"
          onClick={() =>
            exec('subdivide', { cuts: subdivideCuts, smooth: subdivideSmooth }, 'Subdivide')
          }
        />
      </FieldRow>

      <FieldRow legend="CLEAN UP" columns={1}>
        <Button
          label="MERGE BY DISTANCE…"
          hint="Weld nearby vertices together, with a live preview count"
          onClick={() => openDialog('merge')}
        />
        <Button
          label="TRIANGULATE"
          hint="Split every face into triangles"
          onClick={() => exec('triangulate', {}, 'Triangulate')}
        />
        <Button
          label="TRIS TO QUADS"
          hint="Merge adjacent, near-coplanar triangle pairs back into quads"
          onClick={() => exec('trisToQuads', {}, 'Tris to quads')}
        />
      </FieldRow>

      <FieldRow legend="MERGE" columns={1}>
        <Select
          label="MODE"
          value={mergeMode}
          options={MERGE_MODES}
          disabled={!vertexMode}
          hint="Which vertex the others collapse onto"
          onChange={setMergeMode}
        />
        <Button
          label="MERGE"
          disabled={!vertexMode}
          hint={
            vertexMode
              ? 'Weld the selected vertices into one'
              : 'Merging joins vertices — switch to vertex select mode (1)'
          }
          onClick={() => exec('merge', { mode: mergeMode }, `Merge at ${mergeMode}`)}
        />
      </FieldRow>

      <FieldRow legend="TOPOLOGY" columns={2}>
        <Button
          label="FILL"
          hint="Fill a selected open boundary loop with a new face (F)"
          onClick={() => exec('fill', {}, 'Fill')}
        />
        <Button
          label="BRIDGE"
          hint="Connect two open edge loops with a band of quads"
          onClick={() => exec('bridge', {}, 'Bridge')}
        />
        <Button
          label="GROW"
          hint="Extend the selection to adjacent geometry"
          onClick={() => exec('growSelection', {}, 'Grow selection')}
        />
        <Button
          label="SHRINK"
          hint="Remove the border from the current selection"
          onClick={() => exec('shrinkSelection', {}, 'Shrink selection')}
        />
      </FieldRow>

      <FieldRow legend="PROPORTIONAL EDIT" columns={1}>
        <Toggle
          label="ENABLED"
          checked={proportional.enabled}
          hint="Spread transforms to nearby unselected geometry"
          onChange={(enabled) => setProportional({ enabled })}
        />
        <NumberField
          label="RADIUS"
          value={proportional.radius}
          step={0.1}
          min={0}
          disabled={!proportional.enabled}
          hint="How far the falloff reaches from the selection"
          onChange={(radius) => setProportional({ radius })}
        />
        <Select
          label="FALLOFF"
          value={proportional.falloff}
          disabled={!proportional.enabled}
          hint="The curve used to blend influence toward the edge of the radius"
          options={[
            { value: 'smooth', label: 'SMOOTH' },
            { value: 'sphere', label: 'SPHERE' },
            { value: 'root', label: 'ROOT' },
            { value: 'linear', label: 'LINEAR' },
            { value: 'sharp', label: 'SHARP' },
            { value: 'constant', label: 'CONSTANT' },
          ]}
          onChange={(falloff) => setProportional({ falloff })}
        />
      </FieldRow>
    </Panel>
  );
}
