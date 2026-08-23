# Testing

170 tests across the kernel, the store, the component library and the app shell.

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

1. **Exact counts** — vertices, edges, faces. A count that drifts is a bug.
2. **`validate()` returns `[]`** — the half-edge invariants still hold.
3. **Euler characteristic** — `V − E + F = 2` for a closed shell. This catches
   whole classes of errors that counts alone miss.
4. **Orientation** — for convex solids, `dot(faceCentre, faceNormal) > 0` for
   every face. This is how inverted windings get caught.

## Coverage by area

| Suite | Tests | Covers |
| --- | --- | --- |
| `kernel/mesh` | 16 | BMesh structure, radial sets, cascade deletion, triangulation, serialization |
| `kernel/ops` | 43 | Extrude, inset, bevel, loop cut, subdivide, merge, delete, dissolve, fill, bridge, normals, transforms, selection walks |
| `kernel/modifiers` | 14 | Mirror, array, solidify, weld, stack ordering, non-destructiveness |
| `kernel/io` | 25 | OBJ round trip, FBX structure and index encoding, axis presets, project files, undo history, operator registry |
| `store` | 16 | Add/duplicate/join, exec, undo/redo, modifiers, project round trip, locked objects |
| `shared/components` | 31 | Rendering and behaviour of every shared component |
| `domain` | 17 | Keymap resolution, outliner, status bar |
| `app` | 8 | Full shell mounted with the viewport mocked: add a primitive, enter edit mode, subdivide, undo, open dialogs |

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
act(() => useEditorStore.getState().setSnap({ enabled: true, mode: 'vertex' }));
```

## Verifying a change by hand

The kernel is where correctness lives, but some things are worth eyeballing:

1. `npm run dev`, add a cube, <kbd>Tab</kbd> into edit mode.
2. Turn on the **face orientation** overlay. Any red means an inverted normal.
3. Turn on **statistics** in the status bar and watch the counts as you model —
   a count that jumps unexpectedly is the first sign of a topology bug.
4. Export OBJ and reopen it with **Import**. A clean round trip exercises vertex
   order, winding and material assignment together.

## What is not tested yet

Listed in `TODO.txt`, principally:

- Panels beyond the outliner and status bar have no *dedicated* tests. They are
  exercised through the app shell suite, which mounts the real component tree,
  but their individual edge cases are not covered.
- The viewport, camera controller and picking have no tests — they need a WebGL
  context or a mocked one.
- No Blender headless harness validating exported FBX fixtures.
- No end-to-end browser test.
