import {
  DEFAULT_PRIMITIVE_PARAMS,
  METRE_PARAMS,
  PRIMITIVE_DEFAULT_OVERRIDES,
  PRIMITIVE_FIELDS,
  PRIMITIVE_LABELS,
  type PrimitiveKind,
} from '@kernel/index';
import { Button, FieldRow, Panel, SegmentedControl } from '@shared/components';
import { useEditorStore } from '@store/index';
import type { SelectMode } from '@store/types';

const PRIMITIVE_ORDER: PrimitiveKind[] = [
  'cube',
  'plane',
  'circle',
  'grid',
  'uvSphere',
  'icoSphere',
  'cylinder',
  'cone',
  'capsule',
  'torus',
];

/** How each measured param reads inside a hint. */
const MEASURE_WORDS: Record<string, string> = {
  size: 'size',
  radius: 'radius',
  radius2: 'tube',
  height: 'height',
};

/**
 * The size a fresh primitive comes in at, as "radius 1 m, height 2 m".
 *
 * Read off the same defaults the add action uses so the figures quoted in the
 * hints cannot drift away from the shapes the buttons actually make. Every
 * length in the editor is metres: one unit is one metre.
 */
function measures(kind: PrimitiveKind): string {
  const params = { ...DEFAULT_PRIMITIVE_PARAMS, ...PRIMITIVE_DEFAULT_OVERRIDES[kind] };
  return PRIMITIVE_FIELDS[kind]
    .filter((field) => METRE_PARAMS.has(field))
    .map((field) => `${MEASURE_WORDS[field]} ${params[field]} m`)
    .join(', ');
}

const PRIMITIVE_HINTS: Record<PrimitiveKind, string> = {
  cube: `Adds a six-sided cube at the 3D cursor (${measures('cube')})`,
  plane: `Adds a single flat quad at the 3D cursor (${measures('plane')})`,
  circle: `Adds a flat n-gon or an open ring of edges (${measures('circle')})`,
  grid: `Adds a subdivided flat plane, useful as a base mesh (${measures('grid')})`,
  uvSphere: `Adds a sphere built from latitude/longitude rings (${measures('uvSphere')})`,
  icoSphere: `Adds a sphere built from subdivided triangles (${measures('icoSphere')})`,
  cylinder: `Adds a capped or open cylindrical tube (${measures('cylinder')})`,
  cone: `Adds a cone tapering to a single apex vertex (${measures('cone')})`,
  capsule: `Adds a cylinder closed off with a rounded dome at each end (${measures('capsule')})`,
  torus: `Adds a ring swept around a tube radius (${measures('torus')})`,
};

const SELECT_MODE_OPTIONS = [
  { value: 'vertex', label: 'VERT', shortcut: '1', hint: 'Select individual vertices (1)' },
  {
    value: 'edge',
    label: 'EDGE',
    shortcut: '2',
    hint: 'Select edges; Alt+click follows a loop (2)',
  },
  { value: 'face', label: 'FACE', shortcut: '3', hint: 'Select whole faces (3)' },
] as const;

export function AddPanel() {
  const mode = useEditorStore((state) => state.mode);
  const selectMode = useEditorStore((state) => state.selectMode);
  const setSelectMode = useEditorStore((state) => state.setSelectMode);
  const addPrimitive = useEditorStore((state) => state.addPrimitive);

  return (
    <Panel title={mode === 'object' ? 'PRIMITIVES' : 'SELECT'}>
      {mode === 'object' ? (
        <FieldRow columns={2}>
          {PRIMITIVE_ORDER.map((kind) => (
            <Button
              key={kind}
              label={PRIMITIVE_LABELS[kind]}
              hint={PRIMITIVE_HINTS[kind]}
              onClick={() => addPrimitive(kind)}
            />
          ))}
        </FieldRow>
      ) : (
        <FieldRow columns={1}>
          <SegmentedControl<SelectMode>
            label="Select mode"
            options={SELECT_MODE_OPTIONS}
            value={selectMode}
            onChange={setSelectMode}
          />
        </FieldRow>
      )}
    </Panel>
  );
}
