---
paths:
  - "src/bridge/**/*.ts"
---

# Room: bridge

The only place kernel and three meet. `meshBuffers.ts` stays pure (no
three); `ObjectView` builds the geometries. Depth: `docs/rendering.md`.

## Marks against surfaces

The most regressed area of the app: nine leak fixes in seven weeks,
`materials.ts` changed in 28 commits. How a dot or a wire is kept honest:

- The fill is sunk by a constant offset only. A slope term once sank it far
  enough near silhouettes for the far side to climb through.
- The wire is drawn as quads (`LineSegments2`) and lifted by `liftWire`: half
  the line width times the slope of its own two faces, held to 1 to 8. Lifted
  for the steepest face on every edge, it once came through whatever stood in
  front. That is the whole story only in pictures (no pass); see below.
- Dots are lifted the same way through `pointFaces`, and also hidden by
  `dotOccluded` against the occlusion pass, which only counts a face that
  reaches the vertex (its own edges, not a triangle's diagonal).
- In the viewport's frame the pass decides what hides the wire (`wireHidden`):
  once per spot along the line, from the four pixels round it, any object's
  face counting where it is in front and reaches the line. Asked per fragment,
  a hidden line's half past an outline drew, and a visible line's half over a
  face climbing towards the eye did not. The depth test only backs it up: the
  lift is a fixed `TESTED_WIRE_LIFT_SLOPE` and a fragment that shows is put in
  front of what the pass drew (`wireInFront`). Held to 8, the fill ate half of
  every line on a face nearly edge on: a thin plate's lines as it turns.
- The wire needs the far corners on the solid (`'far'`) wherever it is drawn
  over its own surface: with `'edges'` alone, a quad a little out of flat stood
  the triangle across its diagonal in front of its own edge. Past the known
  triangle the pass marks soft ends (`SOFT_END_SHIFT`), read by the wire as
  ends and skipped by the dots: a bent n-gon cap hid its own rim edges.
- Washes still test other objects where each fragment lies (`markOccluded`,
  `surfaceTag`); lines no longer carry a tag.
- Far-side edges are culled exactly (`frontEdgeLines`), except in x-ray and
  wireframe, for selected edges, and with the eye inside a closed mesh
  (winding number in `encloses`; the bounding box alone said inside too often).
- Face orientation: while it is on the fill draws front faces only and the red
  back-face mesh is sunk below it by a constant (`createFaceOrientationMaterial`).
  Lifted by its slope it drew red lines along every contour; level with a
  two-sided fill, the fill's own back faces still won contour pixels.
- Outside the viewport's frame `DOT_OCCLUSION` holds `NO_OCCLUSION_MAP`, never
  null. The marks read the map through a `usampler2D`, and WebGL2 drops a draw
  that meets three's float stand-in there, even with the test switched off:
  null took every edge out of the MCP's pictures.

## Before and after a change here

The unit tests read shader source, so they pin how a fix is written, not what
reaches the screen. Run `npm run test:gpu` (room-gpu) and, for a fix, put the
bug back first and watch it fail there.

Dispose every geometry and material: WebGL resources are not collected.
