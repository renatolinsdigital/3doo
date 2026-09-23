import { useEffect, useMemo, useState } from 'react';

import { edgeSlideWays, vertexSlideWays } from '@kernel/index';
import { Button, FieldRow, NumberField, Panel, Select, Slider } from '@shared/components';
import {
  useActiveObject,
  useActiveSelectionCounts,
  useEdgeLoopAvailable,
  useEditorStore,
  useFaceLoopAvailable,
} from '@store/index';

import './TopologyPanel.scss';

const MERGE_MODES = [
  { value: 'center', label: 'AT CENTER' },
  { value: 'cursor', label: 'AT 3D CURSOR' },
  { value: 'last', label: 'AT LAST' },
  { value: 'first', label: 'AT FIRST' },
] as const;

/**
 * What the edit-mode operators do to the surrounding topology: joining and
 * closing geometry, welding it, cleaning it up, and widening the selection
 * those all read from.
 *
 * The operators that take parameters of their own live in `OperationsPanel`.
 */
export function TopologyPanel() {
  const exec = useEditorStore((state) => state.exec);
  const openDialog = useEditorStore((state) => state.openDialog);
  const proportional = useEditorStore((state) => state.proportional);
  const setProportional = useEditorStore((state) => state.setProportional);
  const autoMerge = useEditorStore((state) => state.autoMerge);
  const setAutoMerge = useEditorStore((state) => state.setAutoMerge);
  // Merge and connect both work on individual vertices, so they have nothing
  // to act on in the other two select modes.
  const vertexMode = useEditorStore((state) => state.selectMode === 'vertex');
  // A face loop is named by two adjacent faces, so it has nothing to read in
  // the modes that select vertices and edges. An edge loop is the same story
  // one mode down.
  const faceMode = useEditorStore((state) => state.selectMode === 'face');
  const edgeMode = useEditorStore((state) => state.selectMode === 'edge');

  // Every operator below refuses outright when the selection cannot feed it:
  // the button is disabled to match, and its hint says what to select instead.
  // Triangulate, tris-to-quads and merge-by-distance are absent on purpose:
  // each falls back to the whole mesh, so none of them is ever unavailable.
  const selection = useActiveSelectionCounts();
  // Counts cannot answer these two: geometry that never touches is still
  // geometry, and no loop runs through it.
  const faceLoopAvailable = useFaceLoopAvailable();
  const edgeLoopAvailable = useEdgeLoopAvailable();

  const [mergeMode, setMergeMode] = useState<(typeof MERGE_MODES)[number]['value']>('center');

  // A slide travels along geometry that is already there, so where it may go is
  // read off the mesh rather than typed: one numbered way per edge leaving the
  // vertex, or one per side of the selected edges. Worked out here rather than
  // in a selector because the list is rebuilt from the live mesh, and
  // `meshVersion` is the only thing that reports it has moved.
  const object = useActiveObject();
  const editMode = useEditorStore((state) => state.mode === 'edit');
  const version = useEditorStore((state) => state.meshVersion);
  const setSlideAim = useEditorStore((state) => state.setSlideAim);

  const [slideDirection, setSlideDirection] = useState(1);
  const [slideDistance, setSlideDistance] = useState(0.1);

  const slideWays = useMemo(() => {
    void version;
    if (!object || !editMode) return [];

    const { scale } = object.transform;
    if (vertexMode) return vertexSlideWays(object.mesh, object.mesh.selectedVerts(), scale);
    if (edgeMode) return edgeSlideWays(object.mesh, object.mesh.selectedEdges(), scale);
    return [];
  }, [object, version, editMode, vertexMode, edgeMode]);

  // A selection that has just lost a way leaves the picker naming one that is
  // no longer there, so the figure the buttons run with is the one that is.
  const direction = Math.min(slideDirection, Math.max(slideWays.length, 1));
  const slideWay = slideWays[direction - 1] ?? null;
  // Where the first vertex of the selection to arrive lands on its neighbour:
  // past that the slide would leave the geometry it is travelling along.
  const slideReach = slideWay ? Math.max(0.01, Math.round(slideWay.reach * 1000) / 1000) : 1;
  const slideTravel = Math.min(slideDistance, slideReach);

  // The arrow the viewport draws over the mesh, up while a picked direction has
  // somewhere to go and down with the panel.
  useEffect(() => {
    setSlideAim(
      slideWay
        ? { anchor: slideWay.anchor, direction: slideWay.direction, distance: slideTravel }
        : null,
    );
  }, [setSlideAim, slideWay, slideTravel]);
  useEffect(() => () => setSlideAim(null), [setSlideAim]);

  const slideHint = (element: 'vertex' | 'edge') => {
    const mode = element === 'vertex' ? vertexMode : edgeMode;
    if (!mode) {
      return element === 'vertex'
        ? 'Vertex sliding runs along the edges leaving a vertex, so switch to vertex select mode (1). Shift+G runs the same slide off the pointer'
        : 'Edge sliding runs across the faces beside an edge, so switch to edge select mode (2). Shift+G runs the same slide off the pointer';
    }
    if (!slideWay) {
      return element === 'vertex'
        ? 'Select vertices with an edge to travel along (Shift+G slides them off the pointer)'
        : 'Select edges with a face beside them to travel across (Shift+G slides them off the pointer)';
    }
    return `Slide the selection ${slideTravel}m along direction ${direction}, marked by the arrow over the mesh. Shift+G runs the same slide off the pointer instead, with the mouse carrying the distance`;
  };

  return (
    <Panel title="TOPOLOGY" className="topology">
      <FieldRow legend="BUILD" columns={2}>
        <Button
          label="CONNECT"
          disabled={!vertexMode || selection.verts !== 2}
          hint={
            !vertexMode
              ? 'Connecting joins vertices, so switch to vertex select mode (1)'
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
              : 'Select an open boundary loop (three edges or more) to fill (F)'
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
              ? 'Merging joins vertices, so switch to vertex select mode (1)'
              : selection.verts < 2
                ? 'Select at least two vertices to weld into one'
                : 'Weld the selected vertices into one'
          }
          onClick={() => exec('merge', { mode: mergeMode }, `Merge at ${mergeMode}`)}
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

      <FieldRow legend="SELECTION" columns={2}>
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
          label="EDGE LOOP"
          disabled={!edgeLoopAvailable}
          hint={
            !edgeMode
              ? 'Edge loops run along edges, so switch to edge select mode (2)'
              : selection.edges < 2
                ? 'Select two connected edges for the loop to run along (Alt+click)'
                : !edgeLoopAvailable
                  ? 'Those edges do not meet: a loop is named by two that share a vertex'
                  : 'Extend the selection along the whole loop those edges sit in'
          }
          onClick={() => exec('selectEdgeLoop', {}, 'Select edge loop')}
        />
        <Button
          label="FACE LOOP"
          disabled={!faceLoopAvailable}
          hint={
            !faceMode
              ? 'Face loops run through faces, so switch to face select mode (3)'
              : selection.faces < 2
                ? 'Select two adjacent faces for the loop to run through (Alt+L)'
                : !faceLoopAvailable
                  ? 'Those faces do not touch: a loop is named by two that share an edge (Alt+L)'
                  : 'Extend the selection along the whole loop those faces sit in (Alt+L)'
          }
          onClick={() => exec('selectFaceLoop', {}, 'Select face loop')}
        />
      </FieldRow>

      <FieldRow legend="SLIDE" columns={1}>
        <Select
          label="DIRECTION"
          value={String(direction)}
          // Numbered rather than named: the label says what they are, and
          // spelling it out again in every option widens the whole panel.
          options={Array.from({ length: Math.max(slideWays.length, 1) }, (_, index) => ({
            value: String(index + 1),
            label: String(index + 1),
          }))}
          disabled={!slideWay}
          hint={
            slideWay
              ? 'Which way out of the selection the slide travels. The arrow over the mesh points along the one picked'
              : 'Select vertices or edges in vertex or edge select mode for the slide to have a way to go'
          }
          onChange={(value) => setSlideDirection(Number(value))}
        />
        <Slider
          label="TRAVEL"
          value={slideTravel}
          min={0}
          max={slideReach}
          step={0.001}
          suffix="m"
          disabled={!slideWay}
          hint="How far to travel, in world metres. The track ends where the first vertex of the selection to arrive lands on its neighbour, which is as far as a slide can go"
          onChange={(value) => setSlideDistance(Math.round(value * 1000) / 1000)}
        />
        <div className="topology__slide-buttons">
          <Button
            label="VERTEX SLIDE"
            disabled={!vertexMode || !slideWay}
            hint={slideHint('vertex')}
            onClick={() =>
              exec('vertexSlide', { direction, distance: slideTravel }, 'Vertex slide')
            }
          />
          <Button
            label="EDGE SLIDE"
            disabled={!edgeMode || !slideWay}
            hint={slideHint('edge')}
            onClick={() => exec('edgeSlide', { direction, distance: slideTravel }, 'Edge slide')}
          />
        </div>
      </FieldRow>

      <FieldRow legend="AUTO MERGE" columns={1}>
        <p className="topology__note">
          Switched on and off by the ⋈ button, up beside the mode buttons.
        </p>
        <NumberField
          label="DISTANCE"
          value={autoMerge.threshold}
          step={0.005}
          min={0}
          disabled={!autoMerge.enabled}
          hint="How close a transform has to leave two vertices for them to be welded into one. Measured in the object's own space, so it means the same at any object scale"
          onChange={(threshold) => setAutoMerge({ threshold })}
        />
      </FieldRow>

      <FieldRow legend="PROPORTIONAL EDIT" columns={1}>
        <p className="topology__note">
          Switched on and off by the ◉ button, up beside the mode buttons.
        </p>
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
