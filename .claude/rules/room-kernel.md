---
paths:
  - "src/kernel/**/*.ts"
---

# Room: kernel

Pure TypeScript. If `window` or `THREE` seems needed here, the data belongs in
the caller. Depth: `docs/mesh-kernel.md`, `docs/scripting.md` (operators).

## Invariants

- BMesh is half-edge with per-face loop cycles. Verts, edges and faces sit in
  insertion-ordered `Map`s keyed by monotonic ids, so iteration is
  deterministic and tests can assert exact counts. The radial set is a plain
  array, not a linked cycle.
- Operations mutate the mesh in place. The store bumps `meshVersion`; a kernel
  function never has to.
- Selection lives as flags on verts, edges and faces. `flushSelection(mode)`
  spreads it from the mode's own type to the other two.
- One format, four jobs: `serializeMesh` backs save, undo, autosave copies and
  `cloneMesh`. A format bug shows up in operation tests too.
- `MIN_OBJECT_SIZE` (0.1 mm) floors object size and primitive lengths.

## Tests

- A topology test asserts exact counts, `validate()` is `[]`, Euler
  `V - E + F = 2` for a closed shell, and outward winding.
- Never `toBe` or `toEqual` on a BMesh: the failure diff walks the cyclic
  graph and kills the worker. Compare identity as a boolean.

## Adding an operator

`ops/` implementation with tests, then `OPERATORS` in
`commands/operators.ts` (coercing accessors, a useful status string), then
`OPERATOR_SPECS` in `src/domain/scripting/reference.ts` (a test fails until
both lists match), then a button or key through `store.exec`.

An operator that declines returns `refused: true`. Without it `exec` keeps an
empty undo step and toasts the refusal as a success: merge did, hidden behind a
disabled button, until Shift+M reached it.

## Hot spots, by bug history

- `ops/boolean.ts`, the most fixed op: re-tiling faces the cut never touched,
  faces round a hole shredded into strips, a mirrored cutter arriving inside
  out, quadratic cost, a grey slot per cut, coplanar sheets lost. Its tests
  measure faces and area, and a cost ratio rather than a time. A part left
  open by SEPARATE once read as a sheet and kept the tool's buried walls; its
  rims are now closed for the cut by `capRims` and the lids taken away after
  by `dropCaps`. A face only a few degrees off flat (`WARP_LIMIT`) is one
  source, not one per triangle, or the cut keeps its diagonal. A difference
  cuts with a copy of the tool from `flattenCutter`: each flat run one face,
  or a tiled buried side lines the hole with its diagonals. Its weld keeps the
  corner that bends the faces round it least (`weldBroken`): kept the other
  way, a wall bent by a hair split the target twice and left a scrap.
- `ops/subdivide.ts`: `cuts` once compounded to 2 to the N; a neighbour left
  carrying a row of vertices refused the next cut.
- `ops/dissolve.ts`: the 40 degree fold limit lives at the operator boundary
  on purpose, and only vertices meet it by default (`isDissolvableVert`); the
  primitives merge unconditionally. Edges once met it too, and a selected loop
  crossing a fold kept those edges; `isDissolvableEdge` now runs only for a
  script's `angle`. A dissolved edge's ends go once two edges are left at
  them, bent or not (a sphere ring once left all its points); only an open
  boundary's corners stay. `dissolveEdge` merges across every
  edge its two faces share: a row past a junction once stalled on its second
  edge, which then came back as a diagonal.
- Cleanup after an op is scoped to what it removed (`removeLooseEnds`), never
  `removeWireEdges()` or `removeLooseVerts()` bare: dissolving one vertex once
  swept every wire edge and lone point in the mesh. Bevel, subdivide and
  `detachRegion` still sweep loose verts mesh-wide.
- `ops/fill.ts`: a fill round a sheet's whole outline once folded a face back
  over the mesh. A new face's winding comes from its vertex order, never from
  `addFace`: bridge once took it from the loop walk's direction, built walls
  facing into the solid, and the far-side cull hid their edges. The outline
  test (`fillable`) runs at the operator's `objectScale`: unscaled, a hole at
  a tip of an object squashed to 0.18 in y leaned like an outline and refused.
- `detachRegion` (`ops/region.ts`) duplicates only vertices touching the
  outside, so interior ones are moved in place by the same `offsetFor`; once
  they were not, and every region extrude and inset depth sagged to them.
- `mesh/triangulate.ts`: a concave quad splits through its folded corner.
- Splitting an edge means splicing the new vertex into every face it borders
  (`spliceEdges` in `ops/knife.ts`). `ops/loopcut.ts` once split the edge where
  its ring stopped for its own quads only, leaving a crack the connect walk
  could not cross; saved scenes still carry them, so `closeCracks` in
  `ops/connect.ts` closes any on a connect's line.
- Edit-mode handles are world-aligned and the mesh is in object space.
  Offsets go through the object's whole frame (`inverseTransformOffset` in
  `math/mat4.ts`), not its scale alone, and a world-axis scale passes the
  object's transform as `frame` to `scaleVerts` (`ops/transform.ts`). This
  broke three times.
