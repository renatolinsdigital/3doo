# Testing

2194 tests across the kernel, the bridge, the store, the viewport, the component library and
the app shell, and a separate check of what the viewport draws, run on the real GPU.

```bash
npm test              # everything
npm run test:kernel   # kernel only, fastest feedback
npm run test:watch
npm run coverage
npm run test:gpu      # marks on screen, on this machine's GPU; needs Chrome
```

## The philosophy

**Test the kernel, not screenshots.** Because the kernel has no DOM and no
rendering dependency, every topology operation has a deterministic test that runs
in milliseconds:

```ts
const cube = createBox(2);
extrudeFaces(cube, [topFace], { offset: 1 });

expect(cube.verts.size).toBe(12);
expect(cube.faces.size).toBe(10);
expect(eulerCharacteristic(cube)).toBe(2);
expect(cube.validate()).toEqual([]);
```

The browser validates integration and interaction; the kernel tests validate
geometric correctness.

## Every bug fix gets a regression test

A fix lands together with a test that fails without it and passes with it.
Write the test first and watch it fail, so it is known to catch the bug. Put
it in the suite that already covers the module, at the lowest layer that
shows the problem, and leave a comment above the assertion saying what used
to happen:

```ts
// Typing into one axis used to write the other two back at the two decimal
// places they were displayed with, quietly coarsening a turn nobody touched.
expect(useEditorStore.getState().objects[0].transform.rotation.y).toBe(y);
```

A bug only visible through WebGL is still usually decided by a depth offset,
a shader chunk or a piece of drag arithmetic that a test can reach:
`bridge/materials.test.ts` tests shader source this way. A mark drawn through
a surface, or one left off, also gets a scene or a pose in the GPU check
below, since only the picture can say the fix held. The full rule, including
the rare case where no test can reach the bug, is in
`.claude/rules/regression-tests.md`.

## What a topology test asserts

Good operation tests check four things, not just one:

1. **Exact counts** of vertices, edges, faces. A count that drifts is a bug.
2. **`validate()` returns `[]`**, so the half-edge invariants still hold.
3. **Euler characteristic**: `V − E + F = 2` for a closed shell. This catches
   whole classes of errors that counts alone miss.
4. **Orientation**: for convex solids, `dot(faceCentre, faceNormal) > 0` for
   every face. This is how inverted windings get caught.

## Coverage by area

| Suite | Tests | Covers |
| --- | --- | --- |
| `kernel/math` | 9 | Inverting a transform for a point, an offset and a direction, including a zeroed scale axis, and as a whole matrix |
| `kernel/mesh` | 31 | BMesh structure, radial sets, cascade deletion, primitives, triangulation, serialization, normals after a move |
| `kernel/ops` | 270 | Every modelling operation (extrude, inset, bevel, loop cut, knife, subdivide, relax, circle, space, slide, merge, connect, delete, dissolve, fill, bridge, normals, transforms), the mesh budget, selection walks, pivot arithmetic, and booleans: the result, what they must not touch, what they cost |
| `kernel/modifiers` | 109 | Mirror (seam merge, bisect, wire edges, mirroring about the 3D cursor), array, solidify, bend (the full ring, which side curls, the three axes in order, the cursor as centre, adding no geometry, bending at the object's scale), twist (direction, the cursor as centre, the object's scale, the three axes in order, the clamp, a mesh with no length), lattice (the grid of a cage, nothing moving at rest, corners carried exactly under both interpolations, the fade past the cage, strength, a missing cage, resampling, apply), weld (split seams, array joints, non-transitivity), loop subdivide, subdivision surface, quadify (all quads untouched, stepped and turned unions, a triangulated cube, pole fans as kites, a lone triangle, odd faces paired by a loop, rungs across a bent band, a boolean bite, the join angle, materials, sharp edges, UVs), triangulate (n-gons, concave and bent faces split as drawn, volume and area kept, materials, shading, sharp edges, UVs, the face budget), remesh, stack ordering, non-destructiveness |
| `kernel/remesh` | 34 | Surface sampling, voxel and blocks remeshing, sharp features, decimation, settings |
| `kernel/io` | 66 | OBJ and FBX export (the FBX read back byte by byte), OBJ and FBX import (round trips under every preset, deflated arrays, 64-bit records and ids, ASCII, parents, pivots and mirrors, damaged and outdated files, the mesh budget), image planes with their UVs and pictures, project files and imported images, undo history, the operator registry |
| `bridge` | 134 | Materials (depth offsets, the wire and dot lifts, the dot occlusion test, the face edges and owner it paints, stencil, outline, overlays), silhouette, front-edge and front-vertex buffers, the faces round each vertex, the triangle corners that mark a face's own edges and the far corners across its diagonals, and `ObjectView`: image planes, selection outline, hover mark, vertex dots, which surfaces hide them and which are their own, modifier previews, origin marker, cages |
| `store` | 271 | Add, duplicate, merge, exec, undo and the history timeline, modifiers and lattice cages (the shape a cage remembers across resolutions, and the cage going once its lattice is applied), booleans and their worker, cursor snaps, outliner groups, imported images and meshes, what counts as a change, panel and toast state, viewport requests, and the preference set: storage round trip, coercion of a bad blob, import rejection |
| `viewport` | 342 | Camera orbit, zoom, axis views and pose handover, the orthographic depth range, the TransformControls drag contract and disposal, gizmo colours and guides, grid and snapping, region and click selection, occlusion, picking under a modifier, the modal rotate, slide and offset drags, edit mode transforms applied whole and the one call each comes to, the knife (where a click lands, what a line cuts, the cut end to end, its cursor), the proportional ring, the axis widget, the snapshot cameras, and the `Viewport` itself on a stand-in renderer: a gizmo drag through the store updates it causes, the gizmo leaving an object as it is locked, the handles out of reach for a whole modal scale, the clipping planes at both ends of the zoom |
| `shared/components` | 73 | Rendering and behaviour of every shared component |
| `domain` | 369 | Keymap resolution (including which shifted keys actually reach the handler), the autosave and project-file hooks and services, scene links and the hand-over from a shared page, and dedicated suites for the outliner, the properties, operations, loop operations and topology panels, the tool rail, status bar, cursor menu, axis widget and the confirmation and history dialogs |
| `app` | 98 | Full shell mounted with the viewport mocked: modelling end to end, the top bar, right-click, the reload keys, autosave in preferences, and module routing; the automation API behind the MCP server |
| `mcp` | 24 | The MCP server's JSON-RPC transport, each tool against a fake engine, the page `share_link` saves (run in jsdom), the call queue, protocol negotiation, configuration |

## Two traps worth knowing

**Never assert on a `BMesh` with `toBe` or `toEqual`.** A failing identity check
makes the reporter walk the cyclic half-edge graph to build a diff, which
exhausts memory and kills the worker. Compare identity as a boolean instead:

```ts
expect(copy.mesh === original.mesh).toBe(false);
```

**Wrap out-of-band store updates in `act`.** Calling a store action directly
while a component is mounted updates React state outside the test renderer:

```ts
act(() => useEditorStore.getState().setPreferences({ snapEnabled: true }));
```

## The viewport in jsdom

`viewport/Viewport.test.ts` builds the real `Viewport` with the one part jsdom
cannot provide, the WebGL renderer, swapped for a stand-in. The camera, the
gizmo, the store subscriptions and the scene sync are the real code, so a test
there catches wiring a pure function pulled out of the class never could: a
lock that no subscription answers, a resync that re-seats the gizmo mid-drag.
Reach into its private fields only to drive and read what a user would.

## On the real GPU

`npm run test:gpu` runs `gpu/leaks.test.ts`, kept out of `npm test` because it
needs Chrome and takes seconds rather than milliseconds. It serves the editor
with Vite, opens it in Chrome on this machine's own GPU (no SwiftShader), and
loads `gpu/page.ts` into the page, which shares the app's modules.

For each scene and each camera pose it asks whether the viewport draws a vertex
dot or a piece of edit mode wire that a surface stands in front of, or leaves
one off that nothing hides. Two sources answer, and neither shares code with the
marks under test: a ray cast on the CPU to each vertex and to points along each
edge says what is hidden, and the frame read back with the marks on and off
says what was drawn. The scenes are the ones the leaks came back in: a thin
plate edge on, a sheet over a grid of the same mesh, a sphere, a cylinder, a
cube behind another object, and a room seen from inside.

What it cannot judge, by design:

- Ink within 3.5 px of a mark that should show, which could be that mark's
  own. A far-side line running right beside a near one goes unseen.
- A mark left off on a silhouette, where half of every line lies over the
  background and a dark line there has next to no contrast.
- Wire behind its own object's surface by less than the lift the design gives
  it (see `liftWire`), which shows by design.

Each historical fix was put back to check the sweep fails on it: the far-side
cull from inside a mesh, every dot or edge lifted for the steepest face, the
occlusion pass switched off, and the fixed orthographic depth range all fail
it. Dropping only the test of the wire against other objects' surfaces does
not: in edit mode the wire stays hidden behind another object without it.

## Verifying a change by hand

The kernel is where correctness lives, but some things are worth eyeballing:

1. `npm run dev`, add a cube, <kbd>Tab</kbd> into edit mode.
2. Turn on the **face orientation** overlay. Any red means an inverted normal.
3. Turn on **statistics** in the status bar and watch the counts as you model.
   A count that jumps unexpectedly is the first sign of a topology bug.
4. Export OBJ or FBX and reopen it with **Import mesh**. A clean round trip
   exercises vertex order, winding and placement together.

## What is not tested yet

- The top bar, the add, object, boolean and modifier panels, and the export,
  merge, preferences and shortcut dialogs have no *dedicated* tests. They are
  exercised through the app shell suite, which mounts the real component tree,
  but their individual edge cases are not covered.
- The `Viewport` class runs in jsdom on a stand-in renderer, so its wiring is
  tested but nothing it draws is. What reaches the screen is checked only by
  `npm run test:gpu`, and only for edit mode dots and wire.
- No Blender headless harness validating exported FBX fixtures.
- No end-to-end browser test beyond the GPU check.
