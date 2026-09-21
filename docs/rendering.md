# Rendering and the display bridge

How a kernel mesh becomes pixels, and how a click becomes a selection.

## Three buffer sets

Each mesh produces three GPU buffer sets, rebuilt when `meshVersion` changes:

| Buffer set | Contents | Drawn as |
| --- | --- | --- |
| Solid | Triangulated positions, normals, UVs, material groups | `THREE.Mesh` |
| Edges | Line segment endpoints | `LineSegments2` |
| Points | Vertex positions with selection colours | `THREE.Points` |

`buildMeshBuffers` in `src/bridge/meshBuffers.ts` is pure: it takes a `BMesh` and
returns typed arrays, importing no Three.js at all. Assembling `BufferGeometry`
happens one layer up in `ObjectView`.

Triangulation happens here and nowhere else in the display path. The kernel
keeps n-gons throughout.

### Picking maps

Two side tables come out of the same pass and make selection possible:

- `triangleFaceIds` maps triangle index to kernel face id
- `vertIds` / `edgeIds` map buffer index to kernel element id

Without these, a raycast hit would identify a triangle with no way back to the
n-gon it came from.

### Material groups

Faces are visited in material order and each run becomes a `BufferGeometry`
group, so a mesh with three material slots draws in three calls with three
materials rather than one flat colour.

### Just-created vertices

An operator can report the vertices it made through `OperatorResult.createdVerts`;
`exec` copies them into the store's transient `recentVerts`, and the viewport
flashes them for `RECENT_VERTS_MS`. It exists because a new vertex is easy to
lose: the midpoint of a subdivided edge lands exactly on the line it split, and
in edge mode the points object is hidden entirely, so nothing would show at all.

The flash is its own `THREE.Points` inside `ObjectView` rather than a recolour
of the existing one, precisely so it can ignore that select-mode rule. Its
expiry is checked in the render loop instead of by a `setTimeout`, so it cannot
fire after the viewport is disposed.

## `ObjectView`

One per scene object. It holds every Three.js object for that mesh (solid,
backfaces, wireframe, selected faces, selected edges, points, normals overlay,
object outline) and rebuilds them from buffers on update.

Visibility is decided per mode:

| Object | Shown when |
| --- | --- |
| Solid | Shading is not pure wireframe |
| Wireframe | Shading includes wire, or edit mode is active |
| Points, selected edges/faces | Edit mode, on the active object |
| Backfaces (red) | The face-orientation overlay is on |
| Outline | Object mode, object is selected |

The object's transform is applied as a matrix on the group with
`matrixAutoUpdate = false`, so it is written once per sync rather than
recomputed every frame.

### Lines on a surface are drawn as quads

WebGL ignores `LineBasicMaterial.linewidth`, and offsets polygons and nothing
else: there is no `POLYGON_OFFSET_LINE`. A plain line therefore comes out one
pixel wide at whatever depth the rasteriser hands it, which is the same depth as
the surface it runs along, since both are built from the same vertices. The
wireframe, the selected edges, the modifier preview and the selection outline
are all `LineSegments2` with a `LineMaterial` instead: that pair expands each
segment into a quad in the vertex shader, and a quad can be offset.

The wire rises towards the camera by four units of the depth buffer's own
resolution **scaled by the surface's slope**, and the fill is sunk by a constant
four with no slope term at all. Both halves matter. The slope-scaled part is
what a line running into a junction between faces seen nearly edge-on needs, and
without it the fill ate the last few pixels of the edge, so the line stopped
short of its corner. Putting that slope term on the fill instead, which is where
it used to live, sank the surface so far at those same angles that the far side
of the model climbed through it: back edges drew as a second line beside the near
one, and the back face won a band of pixels along the contour and shaded it.

The fill keeps its constant offset because the marks that are not drawn as quads
(the vertex dots, the vertex-mode fade, the normals) still need the depth tie
between them and the surface broken.

### Edges on the far side are not drawn at all

Depth is the wrong tool for hiding the back of a model: near a contour the far
side runs within a pixel of the near one, close enough that rounding lets it
through. `frontEdgePositions` leaves out every edge whose faces all face away
from the camera, which is exact at any zoom, and keeps every edge with some
number of faces other than two, since a boundary, a bare wire and a non-manifold
fan have no far side to be on. Skipped in x-ray and wireframe shading, where
seeing through the model is the point, and never applied to the selected edges,
since a selection has to read wherever the user made it.

The whole pass rests on the mesh's own surface standing between a face turned
away and the camera, so it runs only where that much is true: the mesh is
closed, meaning every one of its edges has exactly two faces, and the camera is
outside its bounding box. Both are recorded by `buildEdgeCull` and cost one
comparison each to read. Neither holds for a box cut in half, where the opening
shows the inside of the far walls, nor for a camera standing in a room modelled
as a cube, and in both the faces being looked at are the ones turned away:
culling their edges took the wireframe off the surfaces the user can see. Those
views hand back every edge and let depth decide, contour rounding and all,
which is what it did everywhere before this pass existed. The bounding box is a
coarse stand in for being inside the surface, and it errs towards drawing an
edge, which is the safe way to be wrong.

Which edges those are depends on where the camera stands, so this runs on every
frame of an orbit, and that is what decides how it is written. It reads flat
typed arrays that `buildEdgeCull` flattens out of the half-edge graph: face
normals and centres, and two face indices per edge. Walking the mesh itself
instead costs 17 ms a frame on a 49k-edge sphere against 0.35 ms over the
tables, because the walk pays a map lookup per face, a vector allocated per
centre and a loop chased per edge. The tables change only when the mesh does,
so `ObjectView` holds them against the store's mesh version and a gizmo drag,
which redraws on every pointer move without moving a vertex, does not rebuild
them.

Picking is unaffected: it works from the full edge buffer, so an edge round the
back can still be clicked.

### The selection outline

Only the silhouette is traced, never every edge: the wireframe already says
where the geometry runs, and an outline is about which object you are holding.
Its width and colour are user preferences (see
[state-management.md](state-management.md#user-preferences)), which is the
second reason it cannot be a plain line: WebGL draws every one of those a single
pixel wide, and a preference that could not be honoured would not be worth
offering.

The cost of that shader is `resolution`. It converts a width in **screen pixels**
into clip space itself, so it has to be told how large the viewport is:
`Viewport.resize()` pushes the canvas size into every view's
`setResolution`, and a view created after a resize is seeded from the size the
viewport last saw. Left at its `(1, 1)` default, the outline comes out wider than
the screen.

Only the active object wears the chosen colour; the rest of the selection gets a
darkened mix of it, so a multi-object selection still says which one the
operations will run on. That is derived rather than a second preference, since the
distinction only has to be visible, not configurable.

Which edges are on a silhouette depends on where it is seen from, so the render
loop re-traces the outline whenever the camera has actually moved. Views with
nothing outlined return immediately, and a mesh with no faces has no silhouette
at all: the outline hides itself rather than handing the frustum check an empty
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
the design direction asks for.

**Face orientation** draws a second mesh with `side: THREE.BackSide` in red.
Anywhere red is visible, you are seeing the inside of the surface, which is
exactly the problem you want to catch before exporting.

## Picking

Different element types need different strategies.

**Faces** use a raycast against the solid mesh, then `triangleFaceIds` maps the
hit triangle back to a kernel face.

**Vertices and edges** are picked in **screen space**, not by raycast. They have
no area to hit, so the viewport projects candidates to pixels and takes the
nearest within a 12-pixel radius. This is both more forgiving and closer to what
the user sees. Edges use point-to-segment distance in 2D.

**Box select** projects vertex positions, edge centres or face centres and tests
them against the drag rectangle.

Candidates behind the camera are rejected by their projected depth before any
distance test.

## Camera

`CameraController` is hand-written rather than `OrbitControls`, for two reasons:
the two navigation presets bind different buttons and modifiers, and the viewport
needs to know whether a drag was navigation so it does not also treat it as a
click.

| Preset | Orbit | Pan |
| --- | --- | --- |
| Blender | MMB | Shift + MMB |
| Maya | Alt + LMB | Alt + MMB |

The camera orbits a target point in spherical coordinates. Polar angle is clamped
just short of the poles to avoid the gimbal flip at straight up or down.

For an orthographic camera there is no perspective divide, so the orbit radius
drives the frustum height instead of the eye distance. Otherwise zooming would
do nothing.

Focal length maps to field of view through a 35mm-equivalent sensor height,
matching Blender's readout:

```ts
fov = 2 · atan(12 / focalLength)
```

## The gizmo

`TransformControls` from the Three.js examples, attached to a proxy object.

In **object mode** the proxy carries the object's transform and changes are
written back through `setObjectTransform`.

In **edit mode** the proxy sits at the selection's median point, and each drag
delta is applied to the selected vertices via `translateVerts`. The delta is
divided by the object's scale first, because the gizmo drags in world space while
the mesh edit happens in object space.

`TransformControls` stopped being an `Object3D` in newer Three.js releases and
now exposes its visual through `getHelper()`. `resolveGizmoHelper` supports both
shapes so the viewport works across the version range in `package.json`.

## The grid

Two overlaid `GridHelper`s, a fine one and a coarse one for major divisions,
rescaled each frame by the camera distance to the nearest power of ten. A single
grid is either too dense when zoomed out or too sparse when zoomed in.

## Lifecycle

`ViewportCanvas` is a React component with no props and no state. It creates the
`Viewport` once in an effect, observes its container for resizes, and disposes
everything on unmount. React never touches the scene graph.

Every geometry, material and the renderer itself are disposed explicitly, since
WebGL resources are not garbage collected.
