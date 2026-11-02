---
paths:
  - "gpu/**/*.ts"
---

# Room: GPU check

`npm run test:gpu` serves the app with Vite (port 5288), opens Chrome on the
machine's own GPU (no SwiftShader) and loads `gpu/page.ts` into the page.
Depth and limits: `docs/testing.md`, "On the real GPU".

## How it judges

Per scene and pose: a CPU ray to each vertex and to points every pixel along
each edge says hidden, visible or too close to call; the frame read back
with the marks on and off says what was drawn. Dots and wire are judged
apart, each with the other switched off.

## Traps already paid for

- `page.ts` goes in through a module `<script>` tag: Vitest rewrites
  `import()` inside functions handed to `page.evaluate`.
- The 3D cursor and origin overlays sit at the view centre over everything;
  `build` turns them off.
- A dark mark over the background barely changes a pixel, so "left off" is
  judged only with surface on every side.
- Wire behind its own object gets no allowance: it is judged as strictly as
  wire behind another object.
- `build(name, 'object')` leaves the object unselected: selected, its gizmo and
  outline cover the wire round the view centre, which read as wire left off.
- Wire left off only counts a sample with no ink at all, so a line that lost
  half its width passes it. `thinned` compares the frame with one where the
  wire is drawn with no pass and no depth test (`unhidden`), so it sees both
  taking wire. Within `WIRE_BODY_PX` of a sample only: past that is the
  antialiased rim, which flagged a pixel on a whole silhouette line.
- A steeply bumpy open sheet seen within about fifteen degrees of edge on
  still gets some wire wrong, both ways and the same in every mode: a crest's
  edge lands a hundredth of a pixel from the row it hides, and faces that near
  edge on give the pass slopes and edges it cannot trust. The twisted strips'
  bumps and poses keep clear of it.
- The page opens at `deviceScaleFactor: 1`, where the occlusion map's CSS
  pixels are device ones. On a high-density screen each is 2 by 2, and a fault
  in the pass shows as dashes every two pixels: probe at 2 as well before
  calling a wire fix done.
- Read a pixel finding before trusting it: render the pose, crop round it,
  and compare rows with the mark on and off.
- Never edit `src` while a sweep runs: Vite reloads the page and the sweep
  dies.

## What it is known to catch

Put back and caught: the far-side cull ignoring an eye inside a mesh, every
dot or edge lifted for the steepest face, the occlusion pass off, a fixed
orthographic depth range, the wire's own-surface test off (folded and layered
sheet), the face orientation red lifted by its slope (`orientationInk`, which
counts pixels turned red, not changed), the wire's own surface built with
`'edges'` instead of `'far'` (twisted strips, object and edge mode, `thinned`),
the old per-fragment wire test with its lift held to 8 (sphere, cylinder,
behind another, twisted strips, bent cap, edge under an outline), the soft
ends off (bent cap), `wireHidden`'s deep-in-front rule off (behind another).

To audit a user's own scene rather than these, load the `.3doo` in the page,
read every object's wire, and judge the same way per pose; the scenes here are
what stays in the repo.

`pictureWire` checks pictures rather than the viewport: the wire a snapshot
draws over a cube. To put its bug back, null the occlusion map both in
`materials.ts` and where the viewport resets it after a frame; the page's live
viewport resets it every frame, so one place alone still passes.

To add a scene: `build()` in `page.ts`, poses in `leaks.test.ts`, then put
the bug back and watch it fail before relying on it.
