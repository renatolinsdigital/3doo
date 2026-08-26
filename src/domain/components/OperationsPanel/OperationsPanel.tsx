import { useState } from 'react';

import { Button, FieldRow, NumberField, Panel, Select, Toggle } from '@shared/components';
import {
  useActiveSelectionCounts,
  useEditorStore,
  useFaceLoopAvailable,
  useLoopCutAvailable,
} from '@store/index';

import './OperationsPanel.scss';

const MERGE_MODES = [
  { value: 'center', label: 'AT CENTER' },
  { value: 'cursor', label: 'AT 3D CURSOR' },
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
  // Merge and connect both work on individual vertices, so they have nothing
  // to act on in the other two select modes.
  const vertexMode = useEditorStore((state) => state.selectMode === 'vertex');
  // Subdivide splits edges at their midpoint in edge mode; the Catmull-Clark
  // smoothing only means anything when whole faces are being cut up.
  const edgeMode = useEditorStore((state) => state.selectMode === 'edge');
  // A face loop is named by two adjacent faces, so it has nothing to read in
  // the modes that select vertices and edges.
  const faceMode = useEditorStore((state) => state.selectMode === 'face');

  // Every operator below refuses outright when the selection cannot feed it —
  // the button is disabled to match, and its hint says what to select instead.
  // Triangulate, tris-to-quads and merge-by-distance are absent on purpose:
  // each falls back to the whole mesh, so none of them is ever unavailable.
  const selection = useActiveSelectionCounts();
  // Counts cannot answer this one: two faces that never touch are still two
  // faces, and no loop runs through them.
  const faceLoopAvailable = useFaceLoopAvailable();
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
          max={4}
          hint={
            edgeMode
              ? 'How many vertices to add along each selected edge'
              : 'How many times to split each selected face'
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
                ? 'Split each selected face into four smaller faces (Ctrl+D)'
                : 'Select faces to split into smaller ones (Ctrl+D)'
          }
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
          hint="Split every face into triangles (Alt+T)"
          onClick={() => exec('triangulate', {}, 'Triangulate')}
        />
        <Button
          label="TRIS TO QUADS"
          hint="Merge adjacent, near-coplanar triangle pairs back into quads (Alt+J)"
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
          disabled={!vertexMode || selection.verts < 2}
          hint={
            !vertexMode
              ? 'Merging joins vertices — switch to vertex select mode (1)'
              : selection.verts < 2
                ? 'Select at least two vertices to weld into one'
                : 'Weld the selected vertices into one'
          }
          onClick={() => exec('merge', { mode: mergeMode }, `Merge at ${mergeMode}`)}
        />
      </FieldRow>

      <FieldRow legend="TOPOLOGY" columns={2}>
        <Button
          label="CONNECT"
          disabled={!vertexMode || selection.verts !== 2}
          hint={
            !vertexMode
              ? 'Connecting joins vertices — switch to vertex select mode (1)'
              : selection.verts !== 2
                ? 'Select exactly two vertices to run an edge between (J)'
                : 'Create an edge between the two selected vertices, splitting their faces (J)'
          }
          onClick={() => exec('connect', {}, 'Connect')}
        />
        <Button
          label="FILL"
          disabled={selection.edges < 3}
          hint={
            selection.edges >= 3
              ? 'Fill a selected open boundary loop with a new face (F)'
              : 'Select an open boundary loop — three edges or more — to fill (F)'
          }
          onClick={() => exec('fill', {}, 'Fill')}
        />
        <Button
          label="BRIDGE"
          disabled={selection.edges < 4}
          hint={
            selection.edges >= 4
              ? 'Connect two open edge loops with a band of quads (Alt+B)'
              : 'Select two separate edge loops of matching length to bridge (Alt+B)'
          }
          onClick={() => exec('bridge', {}, 'Bridge')}
        />
        <Button
          label="GROW"
          disabled={selection.verts === 0}
          hint={
            selection.verts > 0
              ? 'Extend the selection to adjacent geometry (])'
              : 'Select some geometry for the selection to grow out from (])'
          }
          onClick={() => exec('growSelection', {}, 'Grow selection')}
        />
        <Button
          label="SHRINK"
          disabled={selection.verts === 0}
          hint={
            selection.verts > 0
              ? 'Remove the border from the current selection ([)'
              : 'Nothing is selected for the selection to shrink back from ([)'
          }
          onClick={() => exec('shrinkSelection', {}, 'Shrink selection')}
        />
        <Button
          label="FACE LOOP"
          disabled={!faceLoopAvailable}
          hint={
            !faceMode
              ? 'Face loops run through faces — switch to face select mode (3)'
              : selection.faces < 2
                ? 'Select two adjacent faces for the loop to run through (Alt+L)'
                : !faceLoopAvailable
                  ? 'Those faces do not touch — a loop is named by two that share an edge (Alt+L)'
                  : 'Extend the selection along the whole loop those faces sit in (Alt+L)'
          }
          onClick={() => exec('selectFaceLoop', {}, 'Select face loop')}
        />
      </FieldRow>

      <FieldRow legend="PROPORTIONAL EDIT" columns={1}>
        <Toggle
          label="ENABLED"
          checked={proportional.enabled}
          hint="Spread transforms to nearby unselected geometry, inside the ring the viewport draws"
          onChange={(enabled) => setProportional({ enabled })}
        />
        <NumberField
          label="RADIUS"
          value={proportional.radius}
          step={0.1}
          min={0}
          disabled={!proportional.enabled}
          hint="How far the falloff reaches from the selection. Scroll to resize it mid-transform, or Ctrl+scroll any time the ring is up"
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
