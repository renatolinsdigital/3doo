# Export and import

OBJ first, then binary FBX, out and back in. Both live in `src/kernel/io/` and
import nothing from the browser. [Importing meshes](#importing-meshes) covers
the way back.

## Why OBJ was built first

OBJ is simple enough to read by eye. Building it first gave the kernel a
known-good interchange target to validate vertex order, winding, normals and
material assignment against, before adding FBX's complexity on top. If a mesh
is wrong in OBJ, the bug is in the kernel, not the writer.

## Axis and unit presets

The editor models in metres: one unit is one metre, which is what a fresh
primitive measures across. The user should not have to understand coordinate
conventions to produce a valid export, so picking a target sets everything:

| Preset | Up axis | Units | Scale |
| --- | --- | --- | --- |
| Unity | Y-up | Metres | 1 |
| Unreal | Z-up | Centimetres | 100 |
| Blender | Y-up | Metres | 1 |
| Maya | Y-up | Centimetres | 100 |

Blender works in Z-up, yet its preset is Y-up on purpose. Blender's OBJ importer
assumes a Y-up file by default and turns it upright on the way in, so a Z-up OBJ
arrived lying on its face. Its own OBJ and FBX exporters write Y-up for the same
reason. The FBX importer reads the axis metadata either way.

Conversion to a Z-up target:

```ts
(x, y, z) → (x, −z, y)
```

Our `+Y` (up) becomes their `+Z` (up), and our `+Z` (toward the viewer) becomes
their `−Y` (forward). Handedness is preserved and the model faces forward.

Normals go through the same rotation, but not the scale.

## Export options

| Option | Effect |
| --- | --- |
| Apply transforms | Bakes object position/rotation/scale into vertices; the node is left at the origin |
| Triangulate | Splits n-gons before writing |
| Per-vertex normals | Emits smoothed normals on faces marked smooth, flat face normals otherwise |
| Selection only | Restricts to selected objects |

Modifiers are always applied: the evaluated mesh is what gets exported. The
dialog says so in its note rather than showing a switch that cannot be turned off.

Exports operate on a **clone**. The document's own mesh is never modified by an
export: triangulating for a game engine must not alter what the user is editing.

## UVs and pictures

**Ordinary geometry is exported without UVs.** The editor has no way to unwrap
a mesh, so any UVs it wrote would be invented, and the next program would have
to throw them away. (An earlier build box-projected a layer onto every face for
exactly that result.) Importers accept a mesh without UVs, and the engines that
need them for lightmaps generate their own.

**Image planes are the exception.** Their UVs are exact, set corner by corner
when the image is imported, and the picture is the whole point. So an image
plane exports the way the viewport draws it:

- **Its UVs**, exactly as the editor holds them, kept through triangulation.
  Some modifiers do not carry them everywhere: mirror, array and solidify keep
  them on the original faces only, and subdivide and remesh drop them. A plane
  under those modifiers looks wrong in the viewport and exports the same way.
- **One material**, named after the picture's file, with the picture on its
  base colour. The viewport puts the image on every face whatever the material
  slots say, so the export does too. The base colour is white, so an importer
  that tints the picture by it leaves the picture unchanged.
- **The picture itself**: beside an OBJ as its own file, inside an FBX.

The picture keeps its imported name, with spaces turned to underscores (an OBJ
reader stops at the first space), plus a suffix (`ref_2.png`) when two pictures
share a name. Several planes showing the same picture share one file.

## OBJ

Standard, with one file for geometry and one for materials, plus a file for
each picture.

- `v` / `vn` with **1-based** indices, faces written as `v//vn`, or `v/vt/vn`
  on an image plane, whose `vt` come one per corner.
- One normal per face (or per smooth vertex), referenced by every corner.
- `o` per object, `usemtl` whenever the material changes.
- `mtllib` names the `.mtl` actually downloaded beside it, which carries the
  project name with spaces turned to underscores.
- A matching `.mtl` with `Kd` base colours, and `map_Kd` naming the picture for
  an image plane.

The importer accepts negative indices (counting back from the last vertex) and
all four face-token formats (`v`, `v/vt`, `v//vn`, `v/vt/vn`). Positions are
collected globally before faces are built, because OBJ indices address the whole
file rather than the current group.

## Binary FBX 7.4

The highest-risk part of the build. Three.js has no FBX exporter, so the writer
is our own: **binary FBX version 7400**.

**Why binary, not ASCII.** The writer started as ASCII, on the theory that every
importer reads it. Blender's does not: its stock importer refuses any ASCII FBX
outright, and the newer native one rejected ours over a missing comma between
wrapped array rows. Binary is what Blender's exporter and the FBX SDK write, so
it is what everything reads. Arrays are stored uncompressed, which the format
allows, so no zlib is needed.

### Structure emitted

```text
FBXHeaderExtension    FBXVersion 7400, timestamp, creator
FileId, CreationTime  a fixed pair (see below)
GlobalSettings        UpAxis, FrontAxis, CoordAxis and their signs, UnitScaleFactor
Documents, References the scene document, whose root node is id 0
Definitions           accurate object counts
Objects               Geometry, Model and Material per mesh;
                      Material, Texture and Video per picture
Connections           Geometry → Model, Model → root (0), Material → Model,
                      Texture → Material's DiffuseColor ("OP"), Video → Texture
Takes                 empty
```

### Pictures

A picture is a `Video` holding the image file's bytes as `Content`, a `Texture`
pointing at it, and a material whose `DiffuseColor` the texture connects to.
Embedding means the one `.fbx` is all an importer needs: Blender loads the
picture from inside the file, and programs built on the FBX SDK read embedded
media too. The names inside still point at the picture's file name, for an
importer that looks on disk first.

The layout follows what Blender's own exporter writes, a file the FBX SDK in
Unity, Unreal and Maya is known to accept.

### Binary encoding

Each node is its end offset (absolute in the file), property count, property
byte length and name, then typed properties, then its children. A 13-byte
all-zero record closes every child list. A node with neither properties nor
children also gets one unless it is the last in its list, which is how the SDK
writes it.

Object names are written as `Cube\0\x01Geometry` (name, separator, class), not
the `Geometry::Cube` of ASCII files.

The SDK checks `FileId` against `CreationTime` with an unpublished algorithm, so
both are the fixed pair Blender's exporter uses. The footer, also fixed, ends
with the version and a magic block after padding to a 16-byte boundary.

### The polygon index encoding

The single most important detail. **The last vertex index of every polygon is
written as `-(index + 1)`:**

```ts
polygonVertexIndex.push(position === loops.length - 1 ? -(vertex + 1) : vertex);
```

That negative value is how an importer knows where one polygon ends and the next
begins. Forget it and the entire mesh imports as garbage, not as a subtle
artefact, but as unrecognisable geometry. There is a dedicated test asserting
that every fourth index of a cube is negative and the rest are not.

### Layer element mapping

Mapping and reference types must be paired correctly, or the importer silently
mis-assigns data:

| Layer | Mapping | Reference |
| --- | --- | --- |
| `LayerElementNormal` | `ByPolygonVertex` | `Direct` |
| `LayerElementUV` (image planes) | `ByPolygonVertex` | `IndexToDirect` |
| `LayerElementMaterial` | `ByPolygon` | `IndexToDirect` |

What the pairs mean:

- `ByPolygonVertex` + `Direct`: one entry per polygon corner, in order, with no
  index array.
- `ByPolygonVertex` + `IndexToDirect` for UVs: an index array as well, with each
  corner pointing at its own entry. It carries no extra information, but it is
  how every other exporter writes UVs.
- `ByPolygon` + `IndexToDirect`: one material index per polygon.

Tests assert that the array lengths match: for a cube, 24 normals × 3 floats
and 6 material indices.

### Axis and unit metadata

FBX names axes by index: 0 = X, 1 = Y, 2 = Z. The up, front and coord axes must
form a **right-handed** system, or importers mirror the model:

| Up axis | UpAxis | FrontAxis | CoordAxis |
| --- | --- | --- | --- |
| Y | 1, +1 | 2, +1 | 0, +1 |
| Z | 2, +1 | 1, −1 | 0, +1 |

The Z-up row is Blender's own system. Writing its front sign as `+1` makes the
system left-handed, which is the mistake the ASCII writer made.

`UnitScaleFactor` is **centimetres per file unit**: 100 when the coordinates are
in metres, 1 when they are in centimetres. Declaring 1 for a metre file makes
every importer shrink the model a hundredfold. `OriginalUpAxis` and
`OriginalUnitScaleFactor` repeat the same values.

### Transforms left on the node

With APPLY TRANSFORMS off, the object's transform goes on the model node
instead of into the vertices, and has to be converted too:

- Translation goes through the point conversion and the unit scale.
- Scale swaps axes with the conversion but never changes sign: `(x, z, y)` for
  Z-up.
- Rotation keeps its angles (permuted like a direction) but not its order. The
  editor composes `Rx·Ry·Rz`, which FBX calls `ZYX`. In Z-up the same rotation
  is `Rx·Rz·Ry`, which is `YZX`. The node declares `RotationOrder`, and sets
  `RotationActive`, without which importers ignore the order.

### Object ids

Ids must be unique and non-zero. `0` is reserved for the scene root, which is
what `C: "OO",<modelId>,0` connects each model to.

## Importing meshes

FILE > IMPORT MESH reads `.obj` and `.fbx`. Both come in through
`meshFromPolygons` in `obj.ts`, and both add their objects through one store
action, `addImportedObjects`: one step to undo, named after the file, every
object selected, at the 3D cursor.

Only geometry comes in. Materials, UVs, normals, animation and skinning stay
behind, since an OBJ's material file is a second file the picker never sees,
and the FBX reader matches the OBJ one rather than half a material pipeline.
Normals are recomputed from the faces.

### Polygons a mesh cannot hold

Files carry polygons a half-edge mesh refuses: a corner repeated in place, a
ring that touches itself, a polygon that collapses to a line. `addFace` throws
on the first of those, and it used to fail the whole OBJ with it. They are now
dropped, and the rest of the file comes in.

A mesh past `MESH_BUDGET` is refused by name ("Scan has 400,000 faces, past
the 250,000 a browser tab can hold") before a single vertex is built, because
past that size the tab dies building it.

### Which FBX files

Binary and ASCII, version 7 onwards, which is every file a current exporter
writes:

- From 7500 on, the three lengths that open a binary record are 64-bit, and
  the record that closes a list is 25 bytes rather than 13.
- Binary arrays are usually deflated. They are inflated through
  `DecompressionStream`, which is a web standard Node provides too, the same as
  the `TextEncoder` the writer uses, so the kernel tests still run it in Node.
  Arrays are inflated only when read: a file carries normals, UVs and animation
  curves an import never looks at.
- Object ids are 64-bit and kept as text. Two ids rounded to the same double
  would wire one model's mesh to another.
- FBX 6 is refused by name, since its geometry lives inside the model and none
  of the above applies.

### Where an FBX object lands

Every model holding a `Mesh` geometry becomes an object. Its whole placement is
baked into the vertices, as the FBX SDK documents it:

```text
world = parent · T · Roff · Rp · Rpre · R · Rpost⁻¹ · Rp⁻¹ · Soff · Sp · S · Sp⁻¹
mesh  = axes · world · Tg · Rg · Sg
```

- `RotationActive` gates `RotationOrder` and the pre and post rotations, which
  are otherwise ignored. Blender's importer reads them the same way. Pre and
  post rotations always turn XYZ.
- The geometric transform (`Tg · Rg · Sg`) moves the mesh without moving the
  model or its children. 3ds Max writes one on nearly everything.
- `axes` is the inverse of the export conversion: the file's coord, up and
  front axes become the editor's X, Y and Z, and `UnitScaleFactor / 100` turns
  the file's units into metres. A file that names no unit is in centimetres,
  the format's default.
- Where the model's origin lands is kept apart, as the object's position, so
  the object still pivots where it did in the program that wrote it.
- A placement that mirrors (a negative scale, or a left-handed axis triple)
  turns every face inside out once baked in, so each polygon's corners are put
  back in the other order.

### Checked against real files

Seven FBX files from Character Creator, 3ds Max, Blender and others, including
a 7.7 file with 64-bit records and a 28 MB character, were read by both this
importer and Blender 3.6's, and compared in the same space. All 37 meshes came
in with the same face counts, and 36 with bounds that agree within 0.0004%. A
scene Blender built for the purpose (a parented Suzanne turning ZXY, a cube
mirrored by a negative scale, a 7-sided n-gon) landed within a micrometre per
vertex.

The odd one out is a 3ds Max prop with a rotated, non-uniformly scaled geometric
offset, where the two importers part by 3.6 mm. Evaluating the SDK formula
above independently, in Blender's own Python, put this importer within 0.4
micrometres of it and Blender's importer 3.6 mm away.

## Validating exports

### Automated

Kernel tests read the binary back node by node, checking every end offset,
property length and closing record, then assert the structure above.

### By hand, in Blender

These checks were run manually and are not in the repository.

**Geometry and transforms.** In Blender 4.5 and 5.0, through both the stock and
the native FBX importer: three objects (an asymmetric marker, a rotated and
non-uniformly scaled sphere, a rotated torus), exported under every preset, with
transforms both applied and left on the node. Every vertex landed within 1e-6
of where it should.

**Image planes.** A 4 by 2 picture whose halves and rows differ in colour,
exported as OBJ and as FBX, triangulated and not. The FBX files sat in a folder
without the image, so the picture had to come from inside them. In every
importer:

- the picture loaded,
- every corner kept its UV,
- the pixel under each corner was the one the editor shows there,
- the unrotated plane faced the front view, upright and unmirrored.

A deliberately flipped export failed the same check, so the check can fail.

### Next step

Turn the manual check into a Blender headless harness:

```bash
blender --background --python validate.py
```

It would import exported fixtures and assert vertex positions, face counts,
material slots and object count, so "does the FBX work?" becomes an automated
test rather than a manual inspection.
