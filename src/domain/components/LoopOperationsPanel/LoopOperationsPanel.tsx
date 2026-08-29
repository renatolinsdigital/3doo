import { useMemo, useState } from 'react';

import {
  budgetRefusal,
  subdivisionCost,
  vertsAfterEdgeSubdivide,
  worthWarning,
} from '@kernel/index';
import { Button, FieldRow, Modal, NumberField, Panel, Toggle } from '@shared/components';
import {
  useActiveObject,
  useActiveSelectionCounts,
  useEditorStore,
  useLoopCutAvailable,
} from '@store/index';

import './LoopOperationsPanel.scss';

const count = (value: number) => Math.round(value).toLocaleString('en-US');

/**
 * The operators that work along edge loops: cutting new ones in, cutting the
 * existing ones finer, and evening out the spacing of the ones already there.
 *
 * They belong together because they read the same topology: a loop cut walks
 * the ring of quads across an edge, a subdivide carries each of its cuts on as
 * a loop through the mesh, and relax straightens and spreads one out. The operators
 * that add geometry without following a loop live in `OperationsPanel`.
 */
export function LoopOperationsPanel() {
  const exec = useEditorStore((state) => state.exec);
  // Subdivide splits edges at their midpoint in edge mode; the Catmull-Clark
  // smoothing only means anything when whole faces are being cut up.
  const edgeMode = useEditorStore((state) => state.selectMode === 'edge');

  // Every operator below refuses outright when the selection cannot feed it:
  // the button is disabled to match, and its hint says what to select instead.
  const selection = useActiveSelectionCounts();
  // Counts cannot answer this one: an edge with triangles on both sides has no
  // quad ring to cut across, however many edges are selected.
  const loopCutAvailable = useLoopCutAvailable();

  const [loopCuts, setLoopCuts] = useState(1);
  const [subdivideCuts, setSubdivideCuts] = useState(1);
  const [subdivideSmooth, setSubdivideSmooth] = useState(0);
  const [confirmingSubdivide, setConfirmingSubdivide] = useState(false);
  const [relaxFactor, setRelaxFactor] = useState(0.5);
  const [relaxIterations, setRelaxIterations] = useState(1);
  const [relaxKeepShape, setRelaxKeepShape] = useState(true);

  // Subdivision is the one operator here that multiplies rather than adds, so
  // it is the one that can take the tab down, the more so now its cuts travel
  // on through the mesh. What it would leave is planned out before the click,
  // by the same planner that will run it: past what a browser holds the button
  // is unavailable and says why, and short of that a heavy run is announced
  // before it is run.
  const object = useActiveObject();
  const version = useEditorStore((state) => state.meshVersion);
  const growth = useMemo(() => {
    // Meshes are edited in place, so the version is the only thing that reports
    // the selection or the geometry has moved. See the store's own selectors.
    void version;
    if (!object) return {};
    return edgeMode
      ? { verts: vertsAfterEdgeSubdivide(object.mesh.verts.size, selection.edges, subdivideCuts) }
      : { faces: subdivisionCost(object.mesh, object.mesh.selectedFaces(), subdivideCuts) };
  }, [object, version, edgeMode, selection.edges, subdivideCuts]);
  const tooMany = budgetRefusal(growth);
  const heavy = tooMany === null && worthWarning(growth);

  const runSubdivide = () => {
    setConfirmingSubdivide(false);
    exec('subdivide', { cuts: subdivideCuts, smooth: subdivideSmooth }, 'Subdivide');
  };

  return (
    <Panel title="LOOP OPERATIONS" className="loop-operations">
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
                ? 'No quad ring runs across that edge: a cone or a fan has only triangles there (Ctrl+R)'
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
              : 'How many cuts to take out of each edge of the face: 1 leaves four faces, 3 leaves sixteen. Each cut runs on through the mesh as a loop, so the faces around it stay quads'
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
          disabled={tooMany !== null || (edgeMode ? selection.edges === 0 : selection.faces === 0)}
          hint={
            tooMany ??
            (heavy
              ? `Leaves about ${count(growth.faces ?? growth.verts ?? 0)} ${edgeMode ? 'vertices' : 'faces'}: the editor will stop responding while it runs`
              : edgeMode
                ? selection.edges > 0
                  ? 'Add a vertex at the midpoint of each selected edge (Ctrl+D)'
                  : 'Select edges to add a midpoint vertex to (Ctrl+D)'
                : selection.faces > 0
                  ? 'Cut each selected face into a grid of smaller faces (Ctrl+D)'
                  : 'Select faces to cut into smaller ones (Ctrl+D)')
          }
          onClick={() => (heavy ? setConfirmingSubdivide(true) : runSubdivide())}
        />
      </FieldRow>

      <FieldRow legend="RELAX" columns={1}>
        <NumberField
          label="FACTOR"
          value={relaxFactor}
          step={0.1}
          min={0}
          max={1}
          hint="How far each vertex travels toward where the relax wants it, per pass"
          onChange={setRelaxFactor}
        />
        <NumberField
          label="ITERATIONS"
          value={relaxIterations}
          integer
          min={1}
          max={50}
          hint="Passes to run; each one starts from the result of the last"
          onChange={setRelaxIterations}
        />
        <Toggle
          label="KEEP SHAPE"
          checked={relaxKeepShape}
          hint="Put each vertex back on the surface it started on, so the loop slides across the shape rather than sinking into it. Off, the same passes smooth the mesh itself"
          onChange={setRelaxKeepShape}
        />
        <Button
          label="RELAX"
          disabled={selection.verts === 0}
          hint={
            selection.verts > 0
              ? 'Pull the kinks out of the selected loop and even out its spacing, keeping it on the surface. Anything that is not a loop smooths against its neighbourhood instead'
              : 'Select vertices (an edge loop is the usual one) to straighten and space out'
          }
          onClick={() =>
            exec(
              'relax',
              { factor: relaxFactor, iterations: relaxIterations, keepShape: relaxKeepShape },
              'Relax',
            )
          }
        />
      </FieldRow>

      <Modal
        title="THIS MIGHT TAKE A WHILE"
        open={confirmingSubdivide}
        onClose={() => setConfirmingSubdivide(false)}
        footer={
          <>
            <Button label="CANCEL" onClick={() => setConfirmingSubdivide(false)} />
            <Button label="SUBDIVIDE ANYWAY" variant="danger" onClick={runSubdivide} />
          </>
        }
      >
        <p>
          {edgeMode
            ? `Cutting ${count(selection.edges)} edge(s) ${subdivideCuts} time(s) leaves about ${count(growth.verts ?? 0)} vertices.`
            : `Cutting ${count(selection.faces)} face(s) ${subdivideCuts} time(s) leaves about ${count(growth.faces ?? 0)} faces.`}
        </p>
        <p className="u-muted">
          Warning: The browser window may freeze for a while. Everything afterward, every edit,
          every redraw, carries the geometry it leaves behind, making subsequent edits heavier.
        </p>
      </Modal>
    </Panel>
  );
}
