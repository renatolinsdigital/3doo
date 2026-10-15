# Rendering and the display bridge

How a kernel mesh becomes pixels, and how a click becomes a selection.

## Three buffer sets

Each mesh produces three GPU buffer sets, rebuilt when `meshVersion` changes:

| Buffer set | Contents | Drawn as |
| --- | --- | --- |
| Solid | Triangulated positions, normals, UVs, material groups | `THREE.Mesh` |
| Edges | Line segment endpoints | `LineSegments2` |
| Points | Vertex positions with selection colours | `THREE.Points` |

`buildMeshBuffers` in `src/bridge/meshBuffers.ts` is pure: it takes a `BMesh`
and returns typed arrays, importing no Three.js at all. `ObjectView`, one layer
up, assembles the `BufferGeometry`.

This is the only place in the display path that triangulates. The kernel keeps
n-gons throughout.

### Picking maps

The same pass produces two side tables, and selection depends on them:

- `triangleFaceIds` maps a triangle index to a kernel face id.
- `vertIds` / `edgeIds` map a buffer index to a kernel element id.

Without them, a raycast hit would name a triangle with no way back to the n-gon
it came from.

### Split normals

A smooth face normally shades each corner with the vertex normal. Where a sharp
edge splits a corner off from its vertex, the corner takes its normal from
`BMesh.cornerNormals` instead (see
[mesh-kernel.md](mesh-kernel.md#sharp-edges-normalsts-bmeshcornernormals)).

The cost is small. On a mesh with no sharp edges, which is most of them, the
map is empty and building it is one pass over the edges: a 51k-face sphere
builds in the same time as before. With one edge in twenty marked sharp it adds
about 10 ms. With every edge marked (which shades the same as flat) it adds
about 50 ms.

### Material groups

Faces are visited in material order, and each run becomes a `BufferGeometry`
group. A mesh with three material slots draws in three calls with three
materials, not one flat colour.

### Just-created vertices

An operator can report the vertices it made through
`OperatorResult.createdVerts`. `exec` copies them into the store's transient
`recentVerts`, and the viewport flashes them for `RECENT_VERTS_MS`.

This exists because a new vertex is easy to lose. The midpoint of a subdivided
edge lands exactly on the line it split, and in edge mode the points object is
hidden entirely, so nothing would show at all.

The flash is its own `THREE.Points` inside `ObjectView`, not a recolour of the
existing points, so that it ignores the select-mode rule that hides them. Its
expiry is checked in the render loop rather than by a `setTimeout`, so it
cannot fire after the viewport is disposed.

## `ObjectView`

There is one `ObjectView` per scene object. It holds every Three.js object for
that mesh (solid, backfaces, wireframe, selected faces, selected edges, points,
normals overlay, object outline) and rebuilds them from buffers on update.

Each is shown or hidden by mode:

| Object | Shown when |
| --- | --- |
| Solid | Shading is not pure wireframe |
| Wireframe | Shading includes wire, or edit mode is active |
| Points, selected edges/faces | Edit mode, on the active object |
| Sharp edges (cyan) | Edit mode, on the active object |
| Backfaces (red) | The face-orientation overlay is on |
| Outline | Object mode, object is selected |

The object's transform is set as a matrix on the group with
`matrixAutoUpdate = false`, so it is written once per sync instead of
recomputed every frame.

### Lines are drawn as quads

**The problem.** A wire edge and the surface it runs along are built from the
same vertices, so they land at the same depth and fight over the same pixels.
WebGL offers no clean fix for lines: it ignores `LineBasicMaterial.linewidth`
(every line is one pixel wide), and polygon offset applies to polygons only
(there is no `POLYGON_OFFSET_LINE`).

**The solution.** Every line that runs on a surface is a `LineSegments2` with a
`LineMaterial`: the wireframe, the sharp and selected edges, the modifier
preview and the selection outline. That pair expands each segment into a quad
in the vertex shader, so the shader decides both the line's width and its
depth. Two adjustments then separate line from surface:

1. **The fill is pushed back** by a constant polygon offset of four units of
   the depth buffer's resolution.
2. **The wire is pulled forward** in the vertex shader, by how much the surface
   under it gains in depth across half the line's width. `liftWire` splices
   this into `LineMaterial`'s shader:
   - Under perspective, both ends move along the view ray, scaling all three
     components. Taking the lift off the depth alone would slide the line
     across the screen.
   - An orthographic camera has no ray to move along, so the lift comes
     straight off the depth.

`WIRE_LIFT_SLOPE` caps how steep a surface may be before the lift stops being
enough. It is eight, a face at about 83 degrees. Past that, a face is edge-on
enough to count as a contour.

**Why not polygon offset with a slope term.** That was the earlier approach,
and it cannot work for a wire quad. Polygon offset scales its slope term by the
polygon's own steepest depth gradient. A wire quad is flat across its width:
all four corners take the depth of the edge they stand on, so its only gradient
runs along the line. The result:

- An edge receding from the camera was lifted hard and drew whole.
- An edge lying across the same face got almost no lift, though the surface
  beside it climbs just as fast. Half of that line lost the depth test (the
  half on the side where the surface comes forward), and which edges went faint
  changed as the camera moved.

Measured on a screenshot of a subdivided cylinder, the edges lying across a
face carried 0.34 of a pixel of ink, against 0.74 for the edges running away
from the camera.

**Why not sink the fill by its slope instead.** At steep angles that sank the
surface so far that the far side of the model climbed through it. Back edges
drew as a second line beside the near one, and the back face won a band of
pixels along the contour and shaded it.

**Why the fill still keeps its constant offset.** The marks not drawn as quads
(the vertex-mode fade, the normals) still need their depth tie with the surface
broken. They sit on the edge's own pixels rather than spreading across a quad,
so the constant is all they need. The vertex dots do spread, and get a lift of
their own (see below).

### Edges on the far side are not drawn

**The problem.** Depth cannot reliably hide the back of a model. Near a
contour, the far side runs within a pixel of the near side, close enough that
rounding lets it through.

**The solution.** `frontEdgePositions` leaves out every edge whose faces all
face away from the camera. This is exact at any zoom. It keeps every edge with
a face count other than two: a boundary, a bare wire and a non-manifold fan
have no far side to be on.

It is skipped:

- in x-ray and wireframe shading, where seeing through the model is the point,
- for the selected edges, since a selection has to show wherever the user made
  it.

Sharp edges are culled the same way, by `frontSharpPositions`, which reads the
same tables (they list the sharp edges' indices for it). Sharp edges are a
property of the mesh, like the wire, not something just picked, like the
selection. And a far-side stub poking through at a contour, easy to miss in the
faint wire, is hard to miss in cyan. That pass decides afresh which faces face
the camera, so an orbit pays for culling twice while sharp edges are on screen,
and not at all while none are.

**When it runs.** The pass assumes the mesh's own surface stands between a
face turned away and the camera. That holds only when both are true:

- the mesh is closed: every edge has exactly two faces,
- the camera is outside the mesh's bounding box.

`buildEdgeCull` records both, and each costs one comparison to read. Neither
holds for a box cut in half, where the opening shows the inside of the far
walls, or for a camera standing inside a room modelled as a cube. In both, the
faces being looked at are the ones turned away, and culling their edges
removed the wireframe from what the user could see. Those views draw every edge
and let depth decide. The bounding box is a coarse stand-in for "inside the
surface", and it errs toward drawing an edge, which is the safe way to be
wrong.

**Why it reads flat tables.** Which edges face away depends on where the camera
stands, so this runs on every frame of an orbit. It reads flat typed arrays
that `buildEdgeCull` extracts from the half-edge graph: face normals, face
centres, and two face indices per edge. Walking the mesh instead costs 17 ms a
frame on a 49k-edge sphere, against 0.35 ms over the tables, because the walk
pays a map lookup per face, a vector allocated per centre and a loop chased per
edge.

The tables change only when the mesh does. `ObjectView` caches them against the
store's mesh version, so a gizmo drag, which redraws on every pointer move
without moving a vertex, does not rebuild them.

Picking is unaffected. It works from the full edge buffer, so an edge round the
back can still be clicked.

### Vertex dots

**The problem.** A dot is a square drawn at the one depth of its vertex, while
the faces round the vertex change depth across it. The fill's constant offset
settles the tie only at the centre. The half of the square over a face leaning
towards the camera lost the depth test, and a dot on an edge came out as a dash.

**The solution.** `liftPoints` pulls each dot towards the camera, the way
`liftWire` pulls a line, by what the surface round it gains in depth across
half the dot. Every point geometry carries a `pointFaces` attribute, built by
`buildPointFaces`: an axis the vertex's faces lean about, and how far the
furthest of them leans from it. No face round the vertex can be turned further
from the view than the axis plus that spread, so the shader sizes the lift for
that angle, clamped to the wire's range: from a face at 45 degrees to one at
83.

The lift used to be the 83 degree one on every dot, twelve pixels of depth at
a dot's size. Zoomed out, a thin part is shallower than that, and the vertices
behind its faces came up through them as a scatter of squares along every
contour.

- **Scale.** The spread is measured with the object's scale applied, since a
  non-uniform scale turns face normals apart. Rotation keeps every angle and is
  left to the shader's normal matrix. That matrix divides the scale back out of
  whatever it is handed, which is why the axis is stored stretched by it.
- **No faces.** A vertex with no face is left at zero, which reads as nothing
  to clear. The hover mark has no faces of its own and takes
  `UNKNOWN_POINT_FACES`, the steepest lift, so it always clears the dot it
  grows out of.

**Dots on the far side are not drawn.** `frontVerts` drops every vertex whose
edges are all on the far side, read from the same tables and under the same
conditions as `frontEdgeLines`, and `refreshForCamera` runs it again as the
camera moves. The marks on just-created vertices go through it too.

**Dots behind anything else are not drawn either.** Sized by its own faces or
not, a lift is pixels of depth, and zoomed out far enough a pixel is deeper than
whatever stands in front. The cull above knows nothing of other objects, nor of
an open mesh. The case that showed it: a thin part modelled eight millimetres
behind the face of another object, whose rim dots came up through that face.
So whether a dot is drawn at all is settled at its vertex, against the
surfaces as they stand in that frame.

- **The pass.** While any dot is on screen, `Viewport.renderDotOcclusion` draws
  the surfaces that write depth, the ones `ObjectView` puts on
  `OCCLUDER_LAYER`, into an integer target at CSS resolution with
  `createDotOcclusionMaterial`. Each pixel holds four words: its surface's
  depth (1 / w under perspective, the depth buffer's own value under an
  orthographic camera), how fast that changes across the screen, and the three
  edges of the face drawn there nearest the pixel (see below).
- **The test.** The dot shader reads the four pixels round its vertex and
  carries each one's surface to the vertex's exact spot along that slope. Both
  depths run straight across the screen over a face, so the carry is exact: a
  vertex meets the faces it sits on to the last rounding error, at any zoom,
  and needs no margin of pixels. A surface in front of the vertex by more than
  `DOT_OCCLUSION_MARGIN`, small enough for rounding alone, hides the dot when
  its face reaches the vertex's spot. The margin is a share of the distance
  under perspective. Under an orthographic camera it is a share of a depth
  range that runs a hundred view heights past the scene, so it is ten times
  finer there: at the same share, the far corners of a part thinner than two
  pixels of depth came up through its front.
- **Where a face ends.** Depth and slope say how deep a pixel's face would be
  at the vertex, not whether the face gets that far. So the pass also writes
  the three edges of that face nearest the pixel: how far off each is and the
  way into the face, rounded to under a hundredth of a pixel at the spots a
  dot asks about, sixteen bits an edge. A corner's weight runs straight across
  the screen and is nothing along the side facing it, which gives the sides of
  the triangle drawn there. `buildSolid` hands every triangle corner a
  `triangleCorner`, which says which of those sides are edges of the face
  rather than diagonals the triangulation drew.
- **Diagonals.** A diagonal is no end to a face, and the triangle across one is
  often a sliver no pixel lands on. Along a contour that sliver can end a
  hundredth of a pixel past the diagonal, short of a vertex on the contour, or
  run on over a vertex hidden behind the face: taken as an end, the diagonal
  let the second through as half a dot, and taken as nothing, it hid the
  first. So each triangle also carries the far corner across each of its first
  two diagonals (`farCornerA` and `farCornerB`) and which sides out to it are
  edges of the face. The pass finds the triangle's own corners from the
  weights, where a corner's weight is one and the others nothing, and draws
  those sides between them and the far corner. A quad comes out exact. A long
  fan is exact one triangle beyond each diagonal, and taken to go on past that.
- **What it costs.** The far corners are an array as long as the positions
  again, and filling it took a rebuild of a 90k-quad mesh from about 77 ms to
  about 108. Only the object whose vertices are marked has its own faces asked
  about, so only it builds them (`buildMeshBuffers` with `'far'`). Every other
  object in edit mode builds the cheap codes alone (`'edges'`), which cost
  nothing measurable, and outside edit mode nothing is built, since no pass
  runs.
- **Another object.** Its face at one of the four pixels hides the vertex when
  it is in front there and also at the face's nearest point to the vertex.
  Where that object's edge passes between the pixel and the vertex,
  the vertex is behind the edge to within a pixel, and the far side of the edge
  may be faces thinner than one, which no pixel lands on: the vertex of a part
  tucked behind a cylinder's contour came up there. A surface in front only
  once carried past its own edge is an outline the vertex stands beside, and
  hides nothing. The cost is a vertex peeking out from behind another object's
  edge by less than a pixel, which goes until the zoom comes in. The pass
  knows whose pixel is whose from `userData.ownsDots`, which `ObjectView` sets
  on its solid while it has dots on screen, read per object as the pass draws
  it.
- **Why not one pixel, or all four.** The rule used to be that one of the four
  pixels with nothing in front drew the dot. A far-side vertex a fraction of a
  pixel inside a contour has background beside it, so it came up as half a dot
  next to the contour's own vertex, and a vertex just under a thin part did the
  same along the part's edge. Requiring all four to be clear instead loses a
  contour vertex whose own face is narrower than a pixel: the next face over
  leans in front of the vertex without reaching it. Asking whether the face
  reaches settles both.
- **Faces smaller than a pixel.** A face none of the four pixels lands on
  cannot be asked. When all four surfaces stand in front by more than two
  pixels of depth, the dot is hidden anyway: that is something solid in front,
  where the faces round a vertex on a dense curved surface lean in front of it
  by far less. What this misses is a vertex a fraction of a pixel inside a
  contour of its own object made of faces thinner than a pixel.
- **Snapping.** A GPU snaps a triangle's corners to a grid before filling it,
  as coarse as a sixteenth of a pixel, which tilts the depth the pass paints.
  On a steep face through a vertex that is more than the margin, and it read as
  the vertex's own face standing in front of it. Each surface is allowed as much
  slack as it climbs across that sixteenth (`RASTER_SNAP`).
- **What counts.** X-ray writes no depth and hides nothing. A picture plane is
  opaque in every shading and hides what is behind it in every one, as it does
  in the frame itself.
- **The fallback.** `DOT_OCCLUSION` is switched on only while the viewport
  draws its own frame. Anywhere else, snapshots included, the dots are left to
  the depth test and their lift.
- **The lift stays.** It is what keeps the square whole once the dot is drawn.

The pass costs a second draw of every opaque surface, which is why it waits for
a dot to be on screen. Picking does not read it: a click can still take a
vertex hidden behind another object.

### The selection outline

Only the silhouette is traced, never every edge. The wireframe already shows
where the geometry runs; the outline shows which object you are holding.

Its width and colour are user preferences (see
[state-management.md](state-management.md#user-preferences)). That is the
second reason it cannot be a plain line: WebGL draws those one pixel wide, and
a width preference that could not be honoured would not be worth offering.

**`resolution` must be set.** The shader converts a width in **screen pixels**
into clip space itself, so it needs to know the viewport size.
`Viewport.resize()` pushes the canvas size into every view's `setResolution`,
and a view created after a resize is seeded from the last size the viewport
saw. Left at its `(1, 1)` default, the outline comes out wider than the screen.

Only the active object wears the chosen colour. The rest of the selection gets
a darker mix of it, so a multi-object selection still shows which object the
operations will run on. The darker shade is derived rather than a second
preference: the difference only has to be visible, not configurable.

Which edges form the silhouette depends on the view, so the render loop
re-traces the outline whenever the camera has actually moved. Views with
nothing outlined return immediately. A mesh with no faces has no silhouette, so
its outline hides itself instead of handing the frustum check an empty
instanced geometry with no bounding sphere.

## Shading modes

| Mode | Material |
| --- | --- |
| Solid | `MeshLambertMaterial` |
| Solid + wire | Same, with the edge set drawn over it |
| Wireframe | Edges only |
| X-ray | `MeshBasicMaterial`, transparent, `depthWrite: false` |
| Matcap | `MeshMatcapMaterial` with a procedurally generated matcap |

The matcap texture is drawn into a canvas as a radial ramp at runtime. That
avoids shipping a binary asset while still giving the flat, high-contrast look
the design asks for.

**Face orientation** draws a second mesh with `side: THREE.BackSide` in red.
Anywhere red shows, you are seeing the inside of the surface, which is exactly
the problem to catch before exporting.

## Picking

Each element type needs its own strategy:

| Element | Strategy |
| --- | --- |
| Faces | Raycast against the solid mesh, then `triangleFaceIds` maps the hit triangle back to a kernel face |
| Vertices, edges | Screen space: project candidates to pixels and take the nearest within 12 pixels. Edges use 2D point-to-segment distance |
| Box select | Project vertex positions, edge centres or face centres and test them against the drag rectangle |

Vertices and edges have no area for a ray to hit, so they are picked in screen
space. That is also more forgiving, and closer to what the user sees.

Candidates behind the camera are rejected by their projected depth before any
distance test.

### The knife

The knife picks twice: where a click lands, and what the line between two clicks
cuts. Both live in [knife.ts](../src/viewport/knife.ts), against a `KnifeView`
that carries the camera into the object's own space.

- **A click** lands on the nearest vertex or point of the cut within 12 pixels,
  else on the nearest edge or piece of the cut within 8, else on the face the
  ray hits. Two candidates drawn in the same spot go to the one nearer the
  camera: square on to a box, every far corner sits exactly behind a near one.
  The spot along an edge comes from the closest approach of the edge to the
  line of sight, not from the fraction of the way across the screen, which
  perspective would skew.
- **A line** is the plane holding both clicks' lines of sight. Every face is
  sliced by it on its own, and the slices are clipped to the span between the
  clicks. A vertex drawn within a pixel of the line counts as lying on it, and
  a corner exactly on the plane counts as on its positive side, which keeps the
  crossings round every face in pairs with no tolerance to tune.

Unlike the selection picks, the knife's visibility is exact rather than a
front-facing test: a point is hidden when another face's slice crosses its line
of sight before the line gets there, which also catches one part of a model
hiding another. In wireframe and x-ray shading nothing is hidden, so the knife
cuts every layer the line passes over.

## Camera

`CameraController` is hand-written rather than `OrbitControls`, for two
reasons:

- the two navigation presets bind different buttons and modifiers,
- the viewport needs to know whether a drag was navigation, so it does not also
  treat it as a click.

| Preset | Orbit | Pan |
| --- | --- | --- |
| Blender (default) | MMB | Shift + MMB |
| Maya | Alt + LMB | Alt + MMB |

The preset is the store's `navigation` field, set with `setNavigation`. No
control in the UI calls it yet, so every session runs the default.

Holding the left and right buttons together pans in both presets. The second
button of a chord raises no `pointerdown`, only a `pointermove` with both bits
set in `buttons`, so `onPointerChord` is asked on every move and the viewport
drops whatever the first button had started. On Windows the right button's
`contextmenu` arrives as it lets go, possibly after the pan has ended, so the
viewport owes one swallowed menu until it arrives or the next press.

The camera orbits a target point in spherical coordinates. The polar angle is
clamped just short of the poles to avoid the gimbal flip at straight up or
down.

A drag turns the orbit by `orbitSpeed` radians per pixel. `ORBIT_SPEED`
(0.005, about 29 degrees per hundred pixels) is 100% on the two ORBIT sliders
in PREFS, and the viewport sets `orbitSpeed` from whichever of
`orbitSpeedSelected` and `orbitSpeedUnselected` applies, switching as the
object selection empties or fills. Nothing selected defaults to 60%: with no
object for the eye to follow round, the whole scene swinging at full speed is
hard to keep track of. The axis widget's drag goes through the same speed.

An orthographic camera has no perspective divide, so the orbit radius drives
the frustum height instead of the eye distance. Otherwise zooming would do
nothing.

Its depth range is fitted every frame by `fitOrthographicDepth`, round the
scene's bounds, the grid and the 3D cursor, with a hundred view heights to
spare. An orthographic depth buffer spreads its steps evenly from near to far,
and those planes used to sit a fixed `clipEnd` either side of the camera. Zoomed
in on a part a few millimetres thick, one step was wider than a pixel, and the
fill's offset of four steps sank it deeper than the part. Edges and dots behind
a face showed through it, in ortho alone: the perspective near plane follows
the zoom in. The fit never reaches past the old fixed range, so nothing that
drew before is clipped.

Focal length maps to field of view through a 35mm-equivalent sensor height,
matching Blender's readout:

```ts
fov = 2 · atan(12 / focalLength)
```

## The gizmo

The gizmo is `TransformControls` from the Three.js examples, attached to a
proxy object.

- In **object mode** the proxy carries the object's transform, and changes are
  written back through `setObjectTransform`.
- In **edit mode** the proxy sits on the pivot (the selection's median point,
  the object's origin or the 3D cursor). The move, turn or scale since the drag
  began is brought back through the object's frame, because the gizmo drags in
  world space while the mesh edit happens in object space, and applied whole by
  `EditMoveDrag` (`src/viewport/editMove.ts`): every pointer move puts back
  what the last one moved and applies the total again. The drag never
  compounds, the wheel can change the proportional radius under it, and on
  confirm it is exactly one `translate`, `rotate` or `scale` call.

`TransformControls` stopped being an `Object3D` in newer Three.js releases and
now exposes its visual through `getHelper()`. `resolveGizmoHelper` supports both
shapes, so the viewport works across the version range in `package.json`.

## The grid

Two overlaid `GridHelper`s, a fine one and a coarse one for major divisions,
are rescaled each frame to the nearest power of ten of the camera distance. A
single grid is either too dense when zoomed out or too sparse when zoomed in.

## Lifecycle

`ViewportCanvas` is a React component with no props and no state. It creates
the `Viewport` once in an effect, observes its container for resizes, and
disposes everything on unmount. React never touches the scene graph.

Every geometry, material and the renderer itself are disposed explicitly,
because WebGL resources are not garbage collected.
