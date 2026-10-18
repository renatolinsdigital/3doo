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
  `markOccluded` and `surfaceTag`. Its own surface is left to the lift, so
  layers of one mesh closer than the lift show each other's wire by design.
- Far-side edges are culled exactly (`frontEdgeLines`), except in x-ray and
  wireframe, for selected edges, and with the eye inside a closed mesh
  (winding number in `encloses`; the bounding box alone said inside too often).
- Outside the viewport's frame `DOT_OCCLUSION` holds `NO_OCCLUSION_MAP`, never
  null. The marks read the map through a `usampler2D`, and WebGL2 drops a draw
  that meets three's float stand-in there, even with the test switched off:
  null took every edge out of the MCP's pictures.

## Before and after a change here

The unit tests read shader source, so they pin how a fix is written, not what
reaches the screen. Run `npm run test:gpu` (room-gpu) and, for a fix, put the
bug back first and watch it fail there.

Dispose every geometry and material: WebGL resources are not collected.
