import { useState } from 'react';

import { Button, FieldRow, NumberField, Panel, Toggle } from '@shared/components';
import { useActiveSelectionCounts, useEditorStore, useLoopCutAvailable } from '@store/index';

/**
 * The edit-mode operators that add geometry, with their parameters.
 *
 * Parameters live in local state and are passed to `exec`, so each run is one
 * undo step with the values the user actually chose. What each operator does to
 * the surrounding topology — welding, filling, cleaning up — sits next door in
 * `TopologyPanel`, so a parameterised operator is never buried among buttons
 * that take none.
 */
export function OperationsPanel() {
  const exec = useEditorStore((state) => state.exec);
  // Subdivide splits edges at their midpoint in edge mode; the Catmull-Clark
  // smoothing only means anything when whole faces are being cut up.
  const edgeMode = useEditorStore((state) => state.selectMode === 'edge');

  // Every operator below refuses outright when the selection cannot feed it —
  // the button is disabled to match, and its hint says what to select instead.
  const selection = useActiveSelectionCounts();
  // Counts cannot answer this one: an edge with triangles on both sides has no
  // quad ring to cut across, however many edges are selected.
  const loopCutAvailable = useLoopCutAvailable();

  const [extrudeOffset, setExtrudeOffset] = useState(1);
  const [extrudeIndividual, setExtrudeIndividual] = useState(false);
  const [insetThickness, setInsetThickness] = useState(0.2);
  const [insetDepth, setInsetDepth] = useState(0);
  const [bevelWidth, setBevelWidth] = useState(0.2);
  const [bevelSegments, setBevelSegments] = useState(1);
  const [loopCuts, setLoopCuts] = useState(1);
  const [subdivideCuts, setSubdivideCuts] = useState(1);
  const [subdivideSmooth, setSubdivideSmooth] = useState(0);

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
          disabled={selection.edges === 0 || !loopCutAvailable}
          hint={
            selection.edges === 0
              ? 'Select an edge for the new loop to cut across (Ctrl+R)'
              : !loopCutAvailable
                ? 'No quad ring runs across that edge — a cone or a fan has only triangles there (Ctrl+R)'
                : "Insert a new edge loop across the selected edge's quad ring (Ctrl+R)"
          }
          onClick={() => exec('loopCut', { cuts: loopCuts }, 'Loop cut')}
        />
      </FieldRow>

      <FieldRow legend="SUBDIVIDE" columns={1}>
        <NumberField
          label="CUTS"
          value={subdivideCuts}
          integer
          min={1}
          // Cuts cost what they say now: sixteen of them is a 17 by 17 grid,
          // where four rounds of the old scheme was already 16 by 16.
          max={16}
          hint={
            edgeMode
              ? 'How many vertices to add along each selected edge'
              : 'How many cuts to take out of each edge of the face: 1 leaves four faces, 3 leaves sixteen'
          }
          onChange={setSubdivideCuts}
        />
        <NumberField
          label="SMOOTH"
          value={subdivideSmooth}
          step={0.1}
          min={0}
          max={1}
          disabled={edgeMode}
          hint={
            edgeMode
              ? 'Smoothing applies when subdividing faces, not edges'
              : 'Blend toward the Catmull-Clark limit surface'
          }
          onChange={setSubdivideSmooth}
        />
        <Button
          label={edgeMode ? 'SUBDIVIDE EDGE' : 'SUBDIVIDE'}
          disabled={edgeMode ? selection.edges === 0 : selection.faces === 0}
          hint={
            edgeMode
              ? selection.edges > 0
                ? 'Add a vertex at the midpoint of each selected edge (Ctrl+D)'
                : 'Select edges to add a midpoint vertex to (Ctrl+D)'
              : selection.faces > 0
                ? 'Cut each selected face into a grid of smaller faces (Ctrl+D)'
                : 'Select faces to cut into smaller ones (Ctrl+D)'
          }
          onClick={() =>
            exec('subdivide', { cuts: subdivideCuts, smooth: subdivideSmooth }, 'Subdivide')
          }
        />
      </FieldRow>
    </Panel>
  );
}
