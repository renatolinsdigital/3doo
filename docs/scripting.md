# The operator API

Every mutation the UI performs goes through one named registry. That single
surface gives the test harness, the undo stack and any external driver the same
entry point.

## Shape

```ts
import { execOperator } from '@kernel/index';

execOperator(
  { mesh, selectMode: 'face', cursor: vec3() },
  'extrude',
  { offset: 1.0 },
);
```

In the app, the store wraps it so history and re-rendering are handled:

```ts
useEditorStore.getState().exec('extrude', { offset: 1 }, 'Extrude');
```

`exec` snapshots the document for undo, runs the operator against the active
object, bumps `meshVersion`, and writes a status string. A failure is caught,
surfaced as a toast, and leaves the mesh untouched.

## Parameters are coerced, not trusted

The registry is a genuine external boundary and can be called with anything,
so every value is read through a coercing accessor with a documented default:

```ts
const offset = readNumber(params, 'offset', 1);
const mode = readString(params, 'mode', ['center', 'cursor', 'first'], 'center');
```

A malformed parameter falls back to its default rather than throwing or producing
`NaN` geometry. An unknown operator name throws with the list of valid names:

```text
Unknown operator "extrud". Available: bevel, bridge, delete, deselectAll, ...
```

## Operators

### Modelling

| Name | Parameters | Notes |
| --- | --- | --- |
| `extrude` | `offset`, `individual`, `alongNormals` | Falls back to edge extrude when no faces are selected |
| `inset` | `thickness`, `depth`, `individual` | |
| `bevel` | `width`, `segments`, `clampOverlap` | Needs an edge selection |
| `loopCut` | `cuts`, `slide` | Starts from the first selected edge |
| `subdivide` | `cuts`, `smooth` | Splits edges in edge select mode, faces otherwise; reports the new vertices |
| `relax` | `factor`, `iterations`, `keepShape` | Straightens and spaces a selected loop, keeping it on the surface |
| `circle` | `factor` | Rounds each selected loop onto the circle that fits it best |
| `space` | `factor` | Evens the gaps along each selected loop, leaving its shape alone |
| `shrinkFatten` | `distance` | Moves along vertex normals |
| `vertexSlide` | `direction` (1 to 3), `distance` (world metres) | Runs the selected vertices down an edge leaving them; the direction numbers the edges of the first one |
| `edgeSlide` | `direction` (1 or 2), `distance` (world metres) | Runs the selected edges across the faces on that side; a border offers the one side it has |

### Cleanup

| Name | Parameters |
| --- | --- |
| `connect` | none (acts on exactly two selected vertices) |
| `mergeByDistance` | `threshold` |
| `merge` | `mode`: `center` \| `cursor` \| `first` \| `last` \| `collapse` |
| `delete` | `mode`: `verts` \| `edges` \| `faces` \| `onlyFaces` \| `edgesAndFaces` |
| `dissolve` | `mode`: `verts` \| `edges` \| `faces` \| `limited`, `angle` (edges: max fold in degrees, default 40; limited: default 5) |
| `triangulate`, `trisToQuads` | `angle` (tris-to-quads only) |

### Topology and normals

| Name | Parameters |
| --- | --- |
| `fill` | `bridge` |
| `bridge` | none |
| `recalculateNormals` | `outside` |
| `flipNormals` | none |
| `shade` | `smooth` |

### Transform and selection

| Name | Parameters |
| --- | --- |
| `translate` | `offset: {x, y, z}` |
| `rotate` | `axis`, `angle` (degrees) |
| `scale` | `scale: {x, y, z}` |
| `selectAll`, `deselectAll`, `invertSelection`, `growSelection`, `shrinkSelection` | none |
| `selectFaceLoop` | none (needs two adjacent selected faces to name the loop) |

## Driving the kernel from a test

Because the kernel has no browser dependency, an operator sequence runs in Node:

```ts
import { createBox, execOperator, vec3 } from '@kernel/index';

const mesh = createBox(2);
for (const face of mesh.faces.values()) {
  if (face.normal.y > 0.99) face.selected = true;
}
mesh.flushSelection('face');

execOperator({ mesh, selectMode: 'face', cursor: vec3() }, 'extrude', { offset: 1 });

expect(mesh.verts.size).toBe(12);
expect(mesh.faces.size).toBe(10);
expect(mesh.validate()).toEqual([]);
```

## Adding an operator

1. Implement the geometry in `src/kernel/ops/`, taking a `BMesh` and returning
   what it created. Add tests asserting exact counts, `validate()` and, for
   closed results, the Euler characteristic.
2. Register it in `OPERATORS` in `src/kernel/commands/operators.ts`, reading
   parameters through the coercing accessors and returning a status string.
3. Add a button or key binding. Both go through `store.exec`, so undo and status
   reporting come for free.

The status string is user-visible: `Extruded 1 face(s) by 1` is useful,
`ok` is not.

## Not yet exposed

There is no `window.app.exec` global for driving the running app from the
browser console yet. The registry it would call is already in place.
