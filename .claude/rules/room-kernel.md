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

## Hot spots, by bug history

- `ops/boolean.ts`, the most fixed op: re-tiling faces the cut never touched,
  faces round a hole shredded into strips, a mirrored cutter arriving inside
  out, quadratic cost, a grey slot per cut, coplanar sheets lost. Its tests
  measure faces and area, and a cost ratio rather than a time.
- `ops/subdivide.ts`: `cuts` once compounded to 2 to the N; a neighbour left
  carrying a row of vertices refused the next cut.
- `ops/dissolve.ts`: the 40 degree fold limit (`isDissolvableEdge`,
  `isDissolvableVert`) lives at the operator boundary on purpose; the
  primitives merge unconditionally. Dissolved edge ends must not linger as
  points on a straight side, or extrude walls round them.
- `ops/fill.ts`: a fill round a sheet's whole outline once folded a face back
  over the mesh.
- `mesh/triangulate.ts`: a concave quad splits through its folded corner.
- Edit-mode handles are world-aligned and the mesh is in object space.
  Offsets go through the object's whole frame (`inverseTransformOffset` in
  `math/mat4.ts`), not its scale alone, and a world-axis scale passes the
  object's transform as `frame` to `scaleVerts` (`ops/transform.ts`). This
  broke three times.
