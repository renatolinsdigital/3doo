---
paths:
  - "src/viewport/**/*.ts"
---

# Room: viewport

`Viewport.ts` is 5,500 lines, changed in 80 commits; only the in-app docs
text changes more. It is built once by `ViewportCanvas` and never re-rendered
by React. Depth: `docs/rendering.md` (camera, gizmo, picking).

## Testing it

- Arithmetic: pull a pure function out and export it, as
  `orthographicDepthRange`, `gizmoScaleRatio` and `shortestAngle` are.
- Wiring: `Viewport.test.ts` builds the real class in jsdom with a stand-in
  `WebGLRenderer` (`vi.mock('three')`). Helpers there: `mount`, `gizmoOf`
  (drive with view coordinates), `frame` (one render loop), `poseAt` (set
  before `mount`), `sees` (frustum check).
- Three's own contract: `gizmoDrag.test.ts` pins TransformControls behaviour
  the drag code relies on, so an upgrade that changes it fails loudly.
- A drag test must compare the object against the pointer, not the handle:
  the drift bug moved the handle along with the object.

## The gizmo

- `updateGizmo` never re-seats mid-drag (the `gizmoDragging` guard). Each
  drag tick bumps `meshVersion` and resyncs; re-seating there took a new
  baseline every tick and the object stuttered.
- `standDownGizmo` must disable, not only hide: three picks invisible
  handles. `attach()` shows the helper again; the render loop hides it
  before drawing.
- State that changes the gizmo without touching geometry or selection needs
  a subscription of its own (the lock had none).
- `handleLostPointerCapture` ends a drag three would leave latched;
  `deferGizmoGrab` lets a click reach geometry under a handle;
  `aimGizmoRays` aims from the orthographic near plane.

## The camera

- Planes follow the zoom every frame: `extendFarPlane` (the fixed 2000 once
  blanked the view), `tightenNearPlane` (distance / 10; a fixed 0.05 cut
  small parts away), `fitOrthographicDepth` (a fixed 4 km let thin parts
  leak).
- The grid is one shader plane that follows the orbit target in whole heavy
  squares and fades out by `GRID_REACH` camera distances; `farPlaneFor` must
  stay beyond that or the fade ends in a hard line. A fixed-size grid showed
  its far corner at the opening zoom.
- The orthographic camera draws from a negative near plane, behind its own
  position: start rays there (`aimRay` in `picking.ts`).
- Scale drags are measured on screen, since three's ratio flips across the
  pivot. Rotate drags unwrap `atan2` with `shortestAngle`.
- `updatePointerCursor` is the canvas cursor's only writer.
