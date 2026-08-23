import { useState } from 'react';

import { Button, FieldRow, NumberField, Panel, Select, Toggle } from '@shared/components';
import { useEditorStore } from '@store/index';

import './OperationsPanel.scss';

const DELETE_MODES = [
  { value: 'verts', label: 'VERTICES' },
  { value: 'edges', label: 'EDGES' },
  { value: 'faces', label: 'FACES' },
  { value: 'onlyFaces', label: 'ONLY FACES' },
] as const;

const DISSOLVE_MODES = [
  { value: 'verts', label: 'VERTICES' },
  { value: 'edges', label: 'EDGES' },
  { value: 'faces', label: 'FACES' },
  { value: 'limited', label: 'LIMITED' },
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

  const [extrudeOffset, setExtrudeOffset] = useState(1);
  const [extrudeIndividual, setExtrudeIndividual] = useState(false);
  const [insetThickness, setInsetThickness] = useState(0.2);
  const [insetDepth, setInsetDepth] = useState(0);
  const [bevelWidth, setBevelWidth] = useState(0.2);
  const [bevelSegments, setBevelSegments] = useState(1);
  const [loopCuts, setLoopCuts] = useState(1);
  const [subdivideCuts, setSubdivideCuts] = useState(1);
  const [subdivideSmooth, setSubdivideSmooth] = useState(0);
  const [deleteMode, setDeleteMode] = useState<(typeof DELETE_MODES)[number]['value']>('verts');
  const [dissolveMode, setDissolveMode] =
    useState<(typeof DISSOLVE_MODES)[number]['value']>('edges');

  return (
    <Panel title="OPERATIONS" className="operations">
      <FieldRow legend="EXTRUDE" columns={1}>
        <NumberField label="OFFSET" value={extrudeOffset} step={0.1} onChange={setExtrudeOffset} />
        <Toggle
          label="INDIVIDUAL"
          checked={extrudeIndividual}
          onChange={setExtrudeIndividual}
        />
        <Button
          label="EXTRUDE"
          variant="primary"
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
          onChange={setInsetThickness}
        />
        <NumberField label="DEPTH" value={insetDepth} step={0.05} onChange={setInsetDepth} />
        <Button
          label="INSET"
          onClick={() => exec('inset', { thickness: insetThickness, depth: insetDepth }, 'Inset')}
        />
      </FieldRow>

      <FieldRow legend="BEVEL" columns={1}>
        <NumberField label="WIDTH" value={bevelWidth} step={0.02} min={0} onChange={setBevelWidth} />
        <NumberField
          label="SEGMENTS"
          value={bevelSegments}
          step={1}
          min={1}
          max={12}
          precision={0}
          onChange={(value) => setBevelSegments(Math.round(value))}
        />
        <Button
          label="BEVEL"
          onClick={() =>
            exec('bevel', { width: bevelWidth, segments: bevelSegments }, 'Bevel')
          }
        />
      </FieldRow>

      <FieldRow legend="LOOP CUT" columns={1}>
        <NumberField
          label="CUTS"
          value={loopCuts}
          step={1}
          min={1}
          max={32}
          precision={0}
          onChange={(value) => setLoopCuts(Math.round(value))}
        />
        <Button label="LOOP CUT" onClick={() => exec('loopCut', { cuts: loopCuts }, 'Loop cut')} />
      </FieldRow>

      <FieldRow legend="SUBDIVIDE" columns={1}>
        <NumberField
          label="CUTS"
          value={subdivideCuts}
          step={1}
          min={1}
          max={4}
          precision={0}
          onChange={(value) => setSubdivideCuts(Math.round(value))}
        />
        <NumberField
          label="SMOOTH"
          value={subdivideSmooth}
          step={0.1}
          min={0}
          max={1}
          onChange={setSubdivideSmooth}
        />
        <Button
          label="SUBDIVIDE"
          onClick={() =>
            exec('subdivide', { cuts: subdivideCuts, smooth: subdivideSmooth }, 'Subdivide')
          }
        />
      </FieldRow>

      <FieldRow legend="CLEAN UP" columns={1}>
        <Button label="MERGE BY DISTANCE…" onClick={() => openDialog('merge')} />
        <Button label="MERGE AT CENTER" onClick={() => exec('merge', { mode: 'center' }, 'Merge')} />
        <Button label="TRIANGULATE" onClick={() => exec('triangulate', {}, 'Triangulate')} />
        <Button label="TRIS TO QUADS" onClick={() => exec('trisToQuads', {}, 'Tris to quads')} />
      </FieldRow>

      <FieldRow legend="DELETE" columns={1}>
        <Select
          label="MODE"
          value={deleteMode}
          options={DELETE_MODES}
          onChange={setDeleteMode}
        />
        <Button
          label="DELETE"
          variant="danger"
          onClick={() => exec('delete', { mode: deleteMode }, `Delete ${deleteMode}`)}
        />
      </FieldRow>

      <FieldRow legend="DISSOLVE" columns={1}>
        <Select
          label="MODE"
          value={dissolveMode}
          options={DISSOLVE_MODES}
          onChange={setDissolveMode}
        />
        <Button
          label="DISSOLVE"
          onClick={() => exec('dissolve', { mode: dissolveMode }, `Dissolve ${dissolveMode}`)}
        />
      </FieldRow>

      <FieldRow legend="TOPOLOGY" columns={2}>
        <Button label="FILL" onClick={() => exec('fill', {}, 'Fill')} />
        <Button label="BRIDGE" onClick={() => exec('bridge', {}, 'Bridge')} />
        <Button label="GROW" onClick={() => exec('growSelection', {}, 'Grow selection')} />
        <Button label="SHRINK" onClick={() => exec('shrinkSelection', {}, 'Shrink selection')} />
      </FieldRow>

      <FieldRow legend="PROPORTIONAL EDIT" columns={1}>
        <Toggle
          label="ENABLED"
          checked={proportional.enabled}
          onChange={(enabled) => setProportional({ enabled })}
        />
        <NumberField
          label="RADIUS"
          value={proportional.radius}
          step={0.1}
          min={0}
          disabled={!proportional.enabled}
          onChange={(radius) => setProportional({ radius })}
        />
        <Select
          label="FALLOFF"
          value={proportional.falloff}
          disabled={!proportional.enabled}
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
