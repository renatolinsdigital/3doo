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
- Wire behind its own object within its lift shows by design; the allowance
  comes from the edge's two faces, not from the shader.
- Read a pixel finding before trusting it: render the pose, crop round it,
  and compare rows with the mark on and off.
- Never edit `src` while a sweep runs: Vite reloads the page and the sweep
  dies.

## What it is known to catch

Put back and caught: the far-side cull ignoring an eye inside a mesh, every
dot or edge lifted for the steepest face, the occlusion pass off, a fixed
orthographic depth range. Not caught: dropping `markOccluded` alone, since in
edit mode something else still hides the wire behind another object.

To add a scene: `build()` in `page.ts`, poses in `leaks.test.ts`, then put
the bug back and watch it fail before relying on it.
