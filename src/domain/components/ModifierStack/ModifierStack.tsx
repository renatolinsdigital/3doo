import {
  type LatticeModifier,
  type Modifier,
  type ModifierType,
  MAX_BEND_ANGLE,
  MAX_LATTICE_RESOLUTION,
  MAX_SHARP_ANGLE,
  MAX_SMOOTHING,
  MAX_SUBSURF_LEVELS,
  MAX_TARGET_FACES,
  MAX_TWIST_ANGLE,
  MAX_VOXEL_SIZE,
  MIN_LATTICE_RESOLUTION,
  MIN_TARGET_FACES,
  MIN_VOXEL_SIZE,
} from '@kernel/index';
import { Button, NumberField, Panel, Select, Toggle, Vector3Field } from '@shared/components';
import { useTooltipTrigger } from '@shared/hooks/useTooltipTrigger';
import { type SceneObject, useActiveObject, useEditorStore } from '@store/index';

import './ModifierStack.scss';

const MODIFIER_INFO: Record<ModifierType, { label: string; description: string }> = {
  mirror: {
    label: 'MIRROR',
    description:
      'Reflects the mesh across a plane on each enabled axis, through the object\u2019s own origin, or through the 3D cursor if you point ORIGIN at it. Merge welds the two halves into one surface where they meet that plane.',
  },
  array: {
    label: 'ARRAY',
    description:
      'Repeats the mesh in a line. Each copy is offset by a fraction of the bounding box, a fixed distance, or both added together.',
  },
  solidify: {
    label: 'SOLIDIFY',
    description:
      'Gives a flat surface thickness by extruding a second shell along the vertex normals and closing the gap around open edges.',
  },
  bend: {
    label: 'BEND',
    description:
      'Curls the mesh around the X, Y and Z axes, in that order. Around each axis, the longer of the two sides square to it curls toward the other, and the angle is spread along its whole length, so 360° closes it into a ring. It only moves the vertices already there, so loop cut the length you want curved.',
  },
  twist: {
    label: 'TWIST',
    description:
      'Turns the mesh about the X, Y and Z axes, in that order. The further along the axis a part lies, the further it turns, so one end turns the whole angle past the other. It only moves the vertices already there, so loop cut the length you want twisted.',
  },
  lattice: {
    label: 'LATTICE',
    description:
      'Shapes the mesh with a cage: a grid of points around it, kept as an object of its own. Select the cage, press Tab and move its points, and the mesh follows, the parts nearest each point the furthest. It only moves the vertices already there, so loop cut where you want the mesh to bend.',
  },
  weld: {
    label: 'WELD',
    description:
      'Fuses vertices closer together considering a DISTANCE threshold. Raising it starts collapsing real detail.',
  },
  subdivide: {
    label: 'LOOP SUBDIVIDE',
    description:
      'Cuts every edge at its midpoint and splits each face into quads around its centre. At SMOOTH 0 the shape stays exactly as it was; raising SMOOTH rounds it off.',
  },
  subsurf: {
    label: 'SUBDIVISION SURFACE',
    description:
      'Splits every face into quads, level after level, and with CATMULL-CLARK on rounds the mesh toward a smooth surface. In edit mode the original mesh stays drawn as a cage around the result, and that cage is what you edit.',
  },
  remesh: {
    label: 'REMESH',
    description:
      'Rebuilds the topology from scratch. VOXEL converts the shape to a grid, then aims to rebuild an even shell. BLOCKS uses the grid directly, preserving its blocky structure. REDUCE simply collapses edges to reduce geometry, so it usually goes last in the stack.',
  },
};

const MODIFIER_OPTIONS = (Object.keys(MODIFIER_INFO) as ModifierType[]).map((type) => ({
  value: type,
  label: MODIFIER_INFO[type].label,
}));

export function ModifierStack() {
  const object = useActiveObject();
  const addModifier = useEditorStore((state) => state.addModifier);
  const updateModifier = useEditorStore((state) => state.updateModifier);
  const removeModifier = useEditorStore((state) => state.removeModifier);
  const moveModifier = useEditorStore((state) => state.moveModifier);
  const applyModifier = useEditorStore((state) => state.applyModifierToMesh);

  if (!object) {
    return (
      <Panel title="MODIFIERS">
        <p className="modifiers__empty">Nothing selected.</p>
      </Panel>
    );
  }

  if (object.lattice) {
    return (
      <Panel title="MODIFIERS" className="modifiers">
        <div className="modifiers__body">
          <p className="modifiers__description">
            A cage takes no modifiers: it shapes the objects whose LATTICE points at it. Press Tab
            and move its points to shape them.
          </p>
          <CageFields cage={object} />
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="MODIFIERS"
      className="modifiers"
      actions={
        <Select
          label="Add modifier"
          hideLabel
          hint="Add a non-destructive modifier to the stack"
          value={'' as ModifierType | ''}
          options={[{ value: '' as const, label: '+ ADD' }, ...MODIFIER_OPTIONS]}
          onChange={(value) => {
            if (value) addModifier(value as ModifierType);
          }}
        />
      }
    >
      {object.modifiers.length === 0 ? (
        <p className="modifiers__empty">
          Stack is empty. Modifiers are non-destructive: the base mesh stays editable.
        </p>
      ) : (
        <ul className="modifiers__list">
          {object.modifiers.map((modifier, index) => (
            <li key={modifier.id} className="modifiers__item">
              <header className="modifiers__header">
                <span className="modifiers__name">{modifier.name}</span>
                <div className="modifiers__controls">
                  <ModifierIconButton
                    label={`Move ${modifier.name} up`}
                    hint="Move this modifier earlier in the stack"
                    disabled={index === 0}
                    onClick={() => moveModifier(modifier.id, -1)}
                  >
                    ▲
                  </ModifierIconButton>
                  <ModifierIconButton
                    label={`Move ${modifier.name} down`}
                    hint="Move this modifier later in the stack"
                    disabled={index === object.modifiers.length - 1}
                    onClick={() => moveModifier(modifier.id, 1)}
                  >
                    ▼
                  </ModifierIconButton>
                  <ModifierIconButton
                    label={`Apply ${modifier.name}`}
                    hint="Bake this modifier into the base mesh and remove it from the stack"
                    onClick={() => applyModifier(modifier.id)}
                  >
                    ✓
                  </ModifierIconButton>
                  <ModifierIconButton
                    label={`Remove ${modifier.name}`}
                    hint="Discard this modifier without applying it"
                    onClick={() => removeModifier(modifier.id)}
                  >
                    ✕
                  </ModifierIconButton>
                </div>
              </header>

              <div className="modifiers__body">
                <p className="modifiers__description">{MODIFIER_INFO[modifier.type].description}</p>
                <Toggle
                  label="ENABLED"
                  checked={modifier.enabled}
                  hint="Include this modifier when the mesh is displayed and exported"
                  onChange={(enabled) => updateModifier(modifier.id, { enabled })}
                />
                <ModifierFields
                  modifier={modifier}
                  onChange={(patch) => updateModifier(modifier.id, patch)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface ModifierIconButtonProps {
  label: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}

/** The stack's reorder/apply/remove glyphs are too small for Button/IconButton's layout. */
function ModifierIconButton({ label, hint, disabled, onClick, children }: ModifierIconButtonProps) {
  const tooltip = useTooltipTrigger(hint);
  return (
    <button
      type="button"
      aria-label={label}
      // See Button: the native attribute would take the hint down with it.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      {...tooltip}
    >
      {children}
    </button>
  );
}

interface ModifierFieldsProps {
  modifier: Modifier;
  onChange: (patch: Partial<Modifier>) => void;
}

function ModifierFields({ modifier, onChange }: ModifierFieldsProps) {
  if (modifier.type === 'mirror') {
    return (
      <>
        <Select
          label="ORIGIN"
          value={modifier.origin ?? 'object'}
          options={[
            { value: 'object', label: 'OBJECT' },
            { value: 'cursor', label: '3D CURSOR' },
          ]}
          hint="Whether the mirror plane passes through the object's origin or the 3D cursor"
          onChange={(origin) => onChange({ origin })}
        />
        {(['x', 'y', 'z'] as const).map((axis) => (
          <Toggle
            key={axis}
            label={`AXIS ${axis.toUpperCase()}`}
            checked={modifier.axes[axis]}
            hint={`Mirror geometry across the ${axis.toUpperCase()} axis`}
            onChange={(checked) => onChange({ axes: { ...modifier.axes, [axis]: checked } })}
          />
        ))}
        <Toggle
          label="MERGE"
          checked={modifier.merge}
          hint="Weld the seam where the mirrored halves meet"
          onChange={(merge) => onChange({ merge })}
        />
        <NumberField
          label="THRESHOLD"
          value={modifier.mergeThreshold}
          step={0.001}
          min={0}
          precision={4}
          hint="How close to the mirror plane a vertex must sit to absorb its own reflection"
          onChange={(mergeThreshold) => onChange({ mergeThreshold })}
        />
        <Toggle
          label="CLIPPING"
          checked={modifier.clipping}
          hint="Snap vertices within the threshold of the mirror plane onto it"
          onChange={(clipping) => onChange({ clipping })}
        />
        <Toggle
          label="BISECT"
          checked={modifier.bisect}
          hint="Cut the mesh at the mirror plane and keep only the positive half"
          onChange={(bisect) => onChange({ bisect })}
        />
      </>
    );
  }

  if (modifier.type === 'array') {
    return (
      <>
        <NumberField
          label="COUNT"
          value={modifier.count}
          integer
          min={1}
          max={128}
          hint="How many copies to place, including the original"
          onChange={(count) => onChange({ count })}
        />
        <Toggle
          label="RELATIVE"
          checked={modifier.useRelative}
          hint="Offset each copy as a fraction of the mesh's own bounding box"
          onChange={(useRelative) => onChange({ useRelative })}
        />
        <Vector3Field
          labelPrefix="REL"
          value={modifier.relativeOffset}
          step={0.1}
          disabled={!modifier.useRelative}
          hint={(axis) => `Relative offset per copy along ${axis.toUpperCase()}`}
          onChange={(relativeOffset) => onChange({ relativeOffset })}
        />
        <Toggle
          label="CONSTANT"
          checked={modifier.useConstant}
          hint="Offset each copy by a fixed distance, on top of the relative offset"
          onChange={(useConstant) => onChange({ useConstant })}
        />
        <Vector3Field
          labelPrefix="CONST"
          value={modifier.constantOffset}
          step={0.1}
          disabled={!modifier.useConstant}
          hint={(axis) => `Constant offset per copy along ${axis.toUpperCase()}`}
          onChange={(constantOffset) => onChange({ constantOffset })}
        />
        <Toggle
          label="MERGE"
          checked={modifier.merge}
          hint="Weld vertices where consecutive copies touch"
          onChange={(merge) => onChange({ merge })}
        />
      </>
    );
  }

  if (modifier.type === 'solidify') {
    return (
      <>
        <NumberField
          label="THICKNESS"
          value={modifier.thickness}
          step={0.01}
          hint="How far to extrude the shell along vertex normals"
          onChange={(thickness) => onChange({ thickness })}
        />
        <Toggle
          label="EVEN OFFSET"
          checked={modifier.evenOffset}
          hint="Split the thickness evenly to either side of the surface"
          onChange={(evenOffset) => onChange({ evenOffset })}
        />
        <Toggle
          label="RIM FILL"
          checked={modifier.rimFill}
          hint="Close the open edge of the shell with rim faces"
          onChange={(rimFill) => onChange({ rimFill })}
        />
      </>
    );
  }

  if (modifier.type === 'bend') {
    return (
      <>
        <Select
          label="ORIGIN"
          value={modifier.origin}
          options={[
            { value: 'object', label: 'OBJECT' },
            { value: 'cursor', label: '3D CURSOR' },
          ]}
          hint="Whether the bend is centred on the object's origin or the 3D cursor. The mesh there stays where it is"
          onChange={(origin) => onChange({ origin })}
        />
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField
            key={axis}
            label={`BEND ${axis.toUpperCase()}`}
            value={modifier.angles[axis]}
            step={1}
            min={-MAX_BEND_ANGLE}
            max={MAX_BEND_ANGLE}
            suffix="°"
            hint={`Degrees to curl the mesh around the ${axis.toUpperCase()} axis. A positive angle curls toward the positive side, a negative one away from it, and 360 closes it into a ring`}
            onChange={(degrees) => onChange({ angles: { ...modifier.angles, [axis]: degrees } })}
          />
        ))}
      </>
    );
  }

  if (modifier.type === 'twist') {
    return (
      <>
        <Select
          label="ORIGIN"
          value={modifier.origin}
          options={[
            { value: 'object', label: 'OBJECT' },
            { value: 'cursor', label: '3D CURSOR' },
          ]}
          hint="Whether the twist turns about the object's origin or the 3D cursor. The mesh level with it holds still"
          onChange={(origin) => onChange({ origin })}
        />
        {(['x', 'y', 'z'] as const).map((axis) => (
          <NumberField
            key={axis}
            label={`TWIST ${axis.toUpperCase()}`}
            value={modifier.angles[axis]}
            step={1}
            min={-MAX_TWIST_ANGLE}
            max={MAX_TWIST_ANGLE}
            suffix="°"
            hint={`Degrees one end of the mesh turns past the other about the ${axis.toUpperCase()} axis. A positive angle turns anticlockwise, looking down the axis from its positive end`}
            onChange={(degrees) => onChange({ angles: { ...modifier.angles, [axis]: degrees } })}
          />
        ))}
      </>
    );
  }

  if (modifier.type === 'lattice') {
    return <LatticeFields modifier={modifier} onChange={onChange} />;
  }

  if (modifier.type === 'weld') {
    return (
      <NumberField
        label="DISTANCE"
        value={modifier.threshold}
        step={0.001}
        min={0}
        precision={4}
        hint="How far apart two vertices can sit and still be fused into one"
        onChange={(threshold) => onChange({ threshold })}
      />
    );
  }

  if (modifier.type === 'subsurf') {
    return (
      <>
        <Toggle
          label="CATMULL-CLARK"
          checked={modifier.catmullClark}
          hint="On rounds the shape toward a smooth surface. Off only splits the faces and keeps the shape as it is"
          onChange={(catmullClark) => onChange({ catmullClark })}
        />
        <NumberField
          label="SUBDIVISION LEVELS"
          value={modifier.levels}
          integer
          min={0}
          max={MAX_SUBSURF_LEVELS}
          hint="How many times to subdivide. Each level brings about four times the faces, and a level that would put the result past what a browser tab holds is skipped"
          onChange={(levels) => onChange({ levels })}
        />
      </>
    );
  }

  if (modifier.type === 'remesh') {
    const grid = modifier.method === 'voxel' || modifier.method === 'blocks';
    return (
      <>
        <Select
          label="METHOD"
          value={modifier.method}
          options={[
            { value: 'voxel', label: 'VOXEL' },
            { value: 'blocks', label: 'BLOCKS' },
            { value: 'decimate', label: 'REDUCE' },
          ]}
          hint="Contour a distance grid, read that grid off blocky, or collapse the cheapest edges"
          onChange={(method) => onChange({ method })}
        />
        {/*
          Both dropdowns sit at the top of the stack, above the numeric fields.
          A native menu opens downward from the control, and one at the foot of
          a long panel opens against the bottom of the window with nowhere to
          go, which is the whole of what makes it look clipped.
        */}
        <Select
          label="TOPOLOGY"
          value={modifier.topology}
          options={[
            { value: 'quads', label: 'QUADS' },
            { value: 'triangles', label: 'TRIANGLES' },
          ]}
          hint="Whether the result is left as quads or cut into triangles"
          onChange={(topology) => onChange({ topology })}
        />
        <Toggle
          label="TARGET FACES"
          checked={modifier.adaptive}
          hint={
            grid
              ? 'Name the face count you want and let it solve the voxel size out of that'
              : 'Name the face count you want instead of a fraction to keep'
          }
          onChange={(adaptive) => onChange({ adaptive })}
        />
        <NumberField
          label="FACES"
          value={modifier.targetFaces}
          integer
          min={MIN_TARGET_FACES}
          max={MAX_TARGET_FACES}
          step={100}
          disabled={!modifier.adaptive}
          hint="Roughly how many faces to come out with"
          onChange={(targetFaces) => onChange({ targetFaces })}
        />
        {grid ? (
          <NumberField
            label="VOXEL SIZE"
            value={modifier.voxelSize}
            step={0.01}
            min={MIN_VOXEL_SIZE}
            max={MAX_VOXEL_SIZE}
            precision={4}
            disabled={modifier.adaptive}
            hint="Edge length of one voxel: the finest detail the grid can hold"
            onChange={(voxelSize) => onChange({ voxelSize })}
          />
        ) : (
          <NumberField
            label="KEEP"
            value={modifier.ratio}
            step={0.05}
            min={0.01}
            max={1}
            precision={2}
            disabled={modifier.adaptive}
            hint="Fraction of the triangles to keep when no face count is named"
            onChange={(ratio) => onChange({ ratio })}
          />
        )}
        {modifier.method === 'voxel' ? (
          <>
            <NumberField
              label="SMOOTHING"
              value={modifier.smoothing}
              integer
              min={0}
              max={MAX_SMOOTHING}
              hint="Relaxation passes over the new shell, evening out the contour's staircase"
              onChange={(smoothing) => onChange({ smoothing })}
            />
            <NumberField
              label="PROJECTION"
              value={modifier.projection}
              step={0.1}
              min={0}
              max={1}
              hint="How far each relaxed vertex is pulled back onto the original surface"
              onChange={(projection) => onChange({ projection })}
            />
            <NumberField
              label="SHARP EDGE"
              value={modifier.sharpAngle}
              integer
              min={0}
              max={MAX_SHARP_ANGLE}
              suffix="°"
              hint="Edges of the original that turn by more than this are held as creases. Zero rounds every one of them off"
              onChange={(sharpAngle) => onChange({ sharpAngle })}
            />
          </>
        ) : null}
        {modifier.method === 'decimate' ? (
          <Toggle
            label="KEEP BORDER"
            checked={modifier.preserveBoundary}
            hint="Refuse to move the open border of a mesh that is not closed"
            onChange={(preserveBoundary) => onChange({ preserveBoundary })}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <NumberField
        label="LEVELS"
        value={modifier.levels}
        integer
        min={0}
        max={3}
        hint="How many times to split every face again. Each level brings about four times the faces, and a level that would put the result past what a browser tab holds is skipped"
        onChange={(levels) => onChange({ levels })}
      />
      <NumberField
        label="SMOOTH"
        value={modifier.smooth}
        step={0.1}
        min={0}
        max={1}
        hint="0 keeps the shape flat and only adds faces. Higher values round the corners off on every level"
        onChange={(smooth) => onChange({ smooth })}
      />
    </>
  );
}

interface LatticeFieldsProps {
  modifier: LatticeModifier;
  onChange: (patch: Partial<LatticeModifier>) => void;
}

function LatticeFields({ modifier, onChange }: LatticeFieldsProps) {
  const objects = useEditorStore((state) => state.objects);
  const addLatticeCage = useEditorStore((state) => state.addLatticeCage);
  const cages = objects.filter((object) => object.lattice);
  const cage = cages.find((object) => object.id === modifier.objectId);

  return (
    <>
      <Select
        label="CAGE"
        value={cage?.id ?? ''}
        options={[
          { value: '', label: 'NONE' },
          ...cages.map((candidate) => ({ value: candidate.id, label: candidate.name })),
        ]}
        hint="The cage whose points shape this mesh. Any cage in the scene will do, and one cage can shape several objects"
        onChange={(objectId) => onChange({ objectId: objectId || null })}
      />
      {cage ? (
        <CageFields cage={cage} />
      ) : (
        <Button
          label="NEW CAGE"
          fullWidth
          hint="Fit a new cage around this mesh and shape it with that one"
          onClick={() => addLatticeCage(modifier.id)}
        />
      )}
      <Select
        label="TRANSITION"
        value={modifier.interpolation}
        options={[
          { value: 'smooth', label: 'SMOOTH' },
          { value: 'linear', label: 'LINEAR' },
        ]}
        hint="How the mesh bends between the cage's points. SMOOTH makes soft curves. LINEAR makes straight lines that bend sharply at each point"
        onChange={(interpolation) => onChange({ interpolation })}
      />
      <NumberField
        label="STRENGTH"
        value={modifier.strength}
        step={0.05}
        min={0}
        max={1}
        precision={2}
        hint="How much of the cage's pull reaches the mesh. 0 leaves it as it is, 1 follows the cage all the way"
        onChange={(strength) => onChange({ strength })}
      />
    </>
  );
}

/** A cage's own settings, the same from its modifier and from the cage itself. */
function CageFields({ cage }: { cage: SceneObject }) {
  const setLatticeResolution = useEditorStore((state) => state.setLatticeResolution);
  const resetLattice = useEditorStore((state) => state.resetLattice);
  const resolution = cage.lattice?.resolution;
  if (!resolution) return null;

  return (
    <>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <NumberField
          key={axis}
          label={`POINTS ${axis.toUpperCase()}`}
          value={resolution[axis]}
          integer
          min={MIN_LATTICE_RESOLUTION}
          max={MAX_LATTICE_RESOLUTION}
          hint={`How many points the cage holds along its own ${axis.toUpperCase()} axis, ${MIN_LATTICE_RESOLUTION} to ${MAX_LATTICE_RESOLUTION}. Changing it keeps the shape the cage gives as closely as the new grid can, and changing it back brings your shape back exactly`}
          onChange={(count) => setLatticeResolution(cage.id, { ...resolution, [axis]: count })}
        />
      ))}
      <Button
        label="RESET CAGE"
        fullWidth
        hint="Put every point of the cage back where it rests, letting the mesh go back to its own shape"
        onClick={() => resetLattice(cage.id)}
      />
    </>
  );
}
