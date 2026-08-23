# Rendering and the display bridge

How a kernel mesh becomes pixels, and how a click becomes a selection.

## Three buffer sets

Each mesh produces three GPU buffer sets, rebuilt when `meshVersion` changes:

| Buffer set | Contents | Drawn as |
| --- | --- | --- |
| Solid | Triangulated positions, normals, UVs, material groups | `THREE.Mesh` |
| Edges | Line segment endpoints | `THREE.LineSegments` |
| Points | Vertex positions with selection colours | `THREE.Points` |

`buildMeshBuffers` in `src/bridge/meshBuffers.ts` is pure: it takes a `BMesh` and
returns typed arrays, importing no Three.js at all. Assembling `BufferGeometry`
happens one layer up in `ObjectView`.

Triangulation happens here and nowhere else in the display path — the kernel
keeps n-gons throughout.

### Picking maps

Two side tables come out of the same pass and make selection possible:

- `triangleFaceIds` — triangle index → kernel face id
- `vertIds` / `edgeIds` — buffer index → kernel element id

Without these, a raycast hit would identify a triangle with no way back to the
n-gon it came from.

### Material groups

Faces are visited in material order and each run becomes a `BufferGeometry`
group, so a mesh with three material slots draws in three calls with three
materials rather than one flat colour.

## `ObjectView`

One per scene object. It holds every Three.js object for that mesh — solid,
backfaces, wireframe, selected faces, selected edges, points, normals overlay,
object outline — and rebuilds them from buffers on update.

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
Anywhere red is visible, you are seeing the inside of the surface — which is
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
drives the frustum height instead of the eye distance — otherwise zooming would
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

Two overlaid `GridHelper`s — a fine one and a coarse one for major divisions —
rescaled each frame by the camera distance to the nearest power of ten. A single
grid is either too dense when zoomed out or too sparse when zoomed in.

## Lifecycle

`ViewportCanvas` is a React component with no props and no state. It creates the
`Viewport` once in an effect, observes its container for resizes, and disposes
everything on unmount. React never touches the scene graph.

Every geometry, material and the renderer itself are disposed explicitly —
WebGL resources are not garbage collected.
