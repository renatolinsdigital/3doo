import { useShallow } from 'zustand/react/shallow';

import {
  MAX_SMOOTHING,
  MAX_TARGET_FACES,
  MAX_VOXEL_SIZE,
  MIN_TARGET_FACES,
  MIN_VOXEL_SIZE,
  type RemeshMethod,
  type RemeshTopology,
} from '@kernel/index';
import {
  Accordion,
  Button,
  FieldRow,
  NumberField,
  Panel,
  SegmentedControl,
  Toggle,
} from '@shared/components';
import { useEditorStore } from '@store/index';

import './RemeshPanel.scss';

const METHOD_OPTIONS = [
  { value: 'voxel', label: 'VOXEL', hint: 'Rebuild the surface as an even quad shell' },
  { value: 'blocks', label: 'BLOCKS', hint: 'Contour straight off the voxel lattice' },
  { value: 'decimate', label: 'REDUCE', hint: 'Collapse the cheapest edges, keep the rest' },
] as const;

const METHOD_NOTES: Record<RemeshMethod, string> = {
  voxel:
    'Samples the model into a voxel grid and contours it back out as an even quad shell. Topology, seams and anything finer than one voxel are replaced.',
  blocks:
    'The same grid, read straight off the lattice with every face axis-aligned. A voxel study of the shape rather than a surface to carry on working.',
  decimate:
    'Collapses the edges that cost the least to lose and leaves the rest of the mesh untouched. The only mode that keeps material slots and detail exactly where they are.',
};

const TOPOLOGY_OPTIONS = [
  {
    value: 'quads',
    label: 'QUADS',
    hint: 'Four-sided faces, which is what a modelling pass wants',
  },
  {
    value: 'triangles',
    label: 'TRIS',
    hint: 'Split every face into triangles, as engines want them',
  },
] as const;

/**
 * Auto-retopology controls for the active object.
 *
 * Every run stands as a preview: the object wears the result while the original
 * mesh is held aside, so a setting can be tried, looked at from the viewport and
 * thrown away without ever entering the undo history.
 */
export function RemeshPanel() {
  const settings = useEditorStore((state) => state.remesh);
  const setSettings = useEditorStore((state) => state.setRemeshSettings);
  const runRemesh = useEditorStore((state) => state.runRemesh);
  const commitRemesh = useEditorStore((state) => state.commitRemesh);
  const revertRemesh = useEditorStore((state) => state.revertRemesh);
  const busy = useEditorStore((state) => state.remeshBusy);
  const pending = useEditorStore((state) => state.remeshPreview !== null);

  // What a run would actually read — the original, when a preview is standing
  // in for it. A target only means anything next to the figure it is aimed at,
  // and without it a count left over from another object reads as reasonable.
  const source = useEditorStore(
    useShallow((state) => {
      void state.meshVersion;

      const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
      if (!object) return null;
      const mesh =
        state.remeshPreview?.objectId === object.id ? state.remeshPreview.source : object.mesh;
      return { name: object.name, faces: mesh.stats().faces };
    }),
  );

  const voxelBased = settings.method !== 'decimate';
  const objectName = source?.name ?? null;
  const ready = objectName !== null && !busy;

  // Reducing to a figure the mesh is already under collapses nothing at all —
  // the one way these controls can be set to do nothing, so it is said here
  // rather than found out by running it.
  const overshoots =
    settings.method === 'decimate' &&
    source !== null &&
    (settings.adaptive ? settings.targetFaces >= source.faces : settings.ratio >= 1);

  return (
    <Panel title="TOPOLOGY" className="remesh-panel">
      <Accordion title="METHOD" defaultOpen>
        <SegmentedControl<RemeshMethod>
          label="Remesh method"
          options={METHOD_OPTIONS}
          value={settings.method}
          onChange={(method) => setSettings({ method })}
        />
        <p className="remesh-panel__note">{METHOD_NOTES[settings.method]}</p>
      </Accordion>

      <Accordion title="DENSITY" defaultOpen>
        <Toggle
          label="TARGET FACE COUNT"
          checked={settings.adaptive}
          hint={
            voxelBased
              ? 'Solve the voxel size back out of a face count instead of setting it by hand'
              : 'Collapse down to a face count instead of a fraction of what is there'
          }
          onChange={(adaptive) => setSettings({ adaptive })}
        />

        {settings.adaptive ? (
          <NumberField
            label="FACES"
            value={settings.targetFaces}
            integer
            min={MIN_TARGET_FACES}
            max={MAX_TARGET_FACES}
            step={100}
            hint="Roughly how many faces to come out with. Denser costs time, and past a point the grid is capped"
            onChange={(targetFaces) => setSettings({ targetFaces })}
          />
        ) : voxelBased ? (
          <NumberField
            label="VOXEL SIZE"
            value={settings.voxelSize}
            min={MIN_VOXEL_SIZE}
            max={MAX_VOXEL_SIZE}
            step={0.01}
            precision={3}
            suffix="M"
            hint="Edge length of one voxel. This is the finest detail the grid can hold — halving it roughly quadruples the face count"
            onChange={(voxelSize) => setSettings({ voxelSize })}
          />
        ) : (
          <NumberField
            label="KEEP"
            value={settings.ratio}
            min={0.01}
            max={1}
            step={0.05}
            precision={2}
            hint="Fraction of the mesh to keep — 0.25 collapses three faces out of every four"
            onChange={(ratio) => setSettings({ ratio })}
          />
        )}

        {overshoots && source ? (
          <p className="remesh-panel__note remesh-panel__note--warn">
            {settings.adaptive
              ? `${source.name} is already down to ${source.faces.toLocaleString()} faces, so a target of ${settings.targetFaces.toLocaleString()} would collapse nothing. Lower it, or turn TARGET FACE COUNT off and keep a fraction instead.`
              : `Keeping all of ${source.name} collapses nothing. Lower KEEP below 1.`}
          </p>
        ) : (
          <p className="remesh-panel__note">
            {source
              ? `${source.name} has ${source.faces.toLocaleString()} faces to work from.`
              : 'Select an object to see what there is to work from.'}
          </p>
        )}
      </Accordion>

      {settings.method === 'voxel' ? (
        <Accordion title="REFINE" defaultOpen>
          <NumberField
            label="SMOOTHING"
            value={settings.smoothing}
            integer
            min={0}
            max={MAX_SMOOTHING}
            hint="Relaxation passes that even out the staircase the grid leaves behind. Too many round the model off"
            onChange={(smoothing) => setSettings({ smoothing })}
          />
          <NumberField
            label="PROJECTION"
            value={settings.projection}
            min={0}
            max={1}
            step={0.05}
            precision={2}
            hint="How far each relaxed vertex is pulled back onto the original surface. This is what puts the detail back after smoothing"
            onChange={(projection) => setSettings({ projection })}
          />
        </Accordion>
      ) : null}

      {settings.method === 'decimate' ? (
        <Accordion title="REFINE" defaultOpen>
          <Toggle
            label="PRESERVE BOUNDARY"
            checked={settings.preserveBoundary}
            hint="Never move the open border of a mesh that is not closed, so a flat panel keeps its outline"
            onChange={(preserveBoundary) => setSettings({ preserveBoundary })}
          />
        </Accordion>
      ) : null}

      <Accordion title="OUTPUT">
        <SegmentedControl<RemeshTopology>
          label="Output topology"
          options={TOPOLOGY_OPTIONS}
          value={settings.topology}
          onChange={(topology) => setSettings({ topology })}
        />
        <Toggle
          label="SMOOTH SHADING"
          checked={settings.smoothShading}
          hint="Shade the result smooth rather than faceted. Only changes how it is lit, never the geometry"
          onChange={(smoothShading) => setSettings({ smoothShading })}
        />
      </Accordion>

      <FieldRow legend="RUN" columns={1}>
        <Button
          label={busy ? 'WORKING…' : pending ? 'RUN AGAIN' : 'REMESH'}
          variant="primary"
          disabled={!ready}
          hint={
            objectName
              ? `Rebuild ${objectName} and show the result without committing to it`
              : 'Select an object in the viewport or the outliner first'
          }
          onClick={runRemesh}
        />
        <Button
          label="APPLY"
          disabled={!pending || busy}
          hint={
            pending
              ? 'Keep the result. One undo step puts the original mesh back'
              : 'Run a remesh first — there is nothing waiting to be kept'
          }
          onClick={commitRemesh}
        />
        <Button
          label="REVERT"
          variant="danger"
          disabled={!pending || busy}
          hint={
            pending
              ? 'Put the original mesh back and forget the result'
              : 'Nothing to revert — the mesh on screen is the committed one'
          }
          onClick={revertRemesh}
        />
      </FieldRow>
    </Panel>
  );
}
