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
  front.
- Dots are lifted the same way through `pointFaces`, and also hidden by
  `dotOccluded` against the occlusion pass, which only counts a face that
  reaches the vertex (its own edges, not a triangle's diagonal).
- Against other objects the wire is tested where it really lies, by
  `markOccluded` and `surfaceTag`. Against its own, by `wireBehindOwn`: the
  surface carried to the wire's line, not the fragment, and only a face that
  reaches it. Left to the lift, hidden edges came through as tips from shared
  vertices on open meshes and folds. It needs face edge codes on the solid, so
  `'edges'` is built in object mode solid-and-wire too.
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
