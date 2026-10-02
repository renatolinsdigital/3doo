# Testing

1506 tests across the kernel, the bridge, the store, the viewport, the component library and
the app shell.

```bash
npm test              # everything
npm run test:kernel   # kernel only, fastest feedback
npm run test:watch
npm run coverage
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
| `kernel/math` | 8 | Inverting a transform for a point, an offset and a direction, including a zeroed scale axis |
| `kernel/mesh` | 31 | BMesh structure, radial sets, cascade deletion, primitives, triangulation, serialization, normals after a move |
| `kernel/ops` | 241 | Every modelling operation (extrude, inset, bevel, loop cut, subdivide, relax, circle, space, slide, merge, connect, delete, dissolve, fill, bridge, normals, transforms), the mesh budget, selection walks, pivot arithmetic, and booleans: the result, what they must not touch, what they cost |
| `kernel/modifiers` | 60 | Mirror (seam merge, bisect, wire edges, mirroring about the 3D cursor), array, solidify, weld (split seams, array joints, non-transitivity), loop subdivide, subdivision surface, remesh, stack ordering, non-destructiveness |
| `kernel/remesh` | 34 | Surface sampling, voxel and blocks remeshing, sharp features, decimation, settings |
| `kernel/io` | 66 | OBJ and FBX export (the FBX read back byte by byte), OBJ and FBX import (round trips under every preset, deflated arrays, 64-bit records and ids, ASCII, parents, pivots and mirrors, damaged and outdated files, the mesh budget), image planes with their UVs and pictures, project files and imported images, undo history, the operator registry |
| `bridge` | 74 | Materials (depth offsets, stencil, outline, overlays), silhouette and front-edge buffers, and `ObjectView`: image planes, selection outline, hover mark, modifier previews, origin marker |
| `store` | 247 | Add, duplicate, merge, exec, undo and the history timeline, modifiers, booleans and their worker, cursor snaps, outliner groups, imported images and meshes, what counts as a change, panel and toast state, viewport requests, and the preference set: storage round trip, coercion of a bad blob, import rejection |
| `viewport` | 239 | Camera orbit, zoom, axis views and pose handover, the TransformControls drag contract and disposal, gizmo colours and guides, grid and snapping, region and click selection, occlusion, picking under a modifier, the modal rotate, slide and offset drags, the proportional ring, the axis widget |
| `shared/components` | 73 | Rendering and behaviour of every shared component |
| `domain` | 347 | Keymap resolution (including which shifted keys actually reach the handler), the autosave and project-file hooks and services, and dedicated suites for the outliner, the properties, operations, loop operations and topology panels, the tool rail, status bar, cursor menu, axis widget and the confirmation and history dialogs |
| `app` | 78 | Full shell mounted with the viewport mocked: modelling end to end, the top bar, right-click, the reload keys, autosave in preferences, and module routing |

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
- The `Viewport` class itself has no tests, since it needs a WebGL context. The
  `viewport` suite covers what it is built from instead: the functions it
  exports (camera, picking, drag arithmetic, the pointer's marks) and the
  TransformControls behaviour its drag handling depends on, so a three upgrade
  that changes those assumptions fails loudly.
- No Blender headless harness validating exported FBX fixtures.
- No end-to-end browser test.
