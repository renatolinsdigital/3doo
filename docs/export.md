# Export

OBJ first, then binary FBX. Both live in `src/kernel/io/` and import nothing from
the browser.

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

Only image planes carry UVs. The editor has no way to unwrap a mesh, so any UVs
written for ordinary geometry would be invented rather than the user's. Exports
used to box-project a layer onto every face for that reason, which only gave the
next program coordinates it would have to throw away. Importers take a mesh
without UVs, and the engines that need them for lightmaps generate their own.

An image plane is the exception: its UVs are exact, set corner by corner when
the image is imported, and the picture is the point of it. So an image plane
goes out the way the viewport draws it:

- with its UVs, exactly as the editor holds them, kept through triangulation.
  Mirror, array and solidify only carry them on the original faces, and
  subdivide and remesh drop them, so a plane under those modifiers looks wrong
  in the viewport and exports the same way;
- with **one material**, named after the picture's file, holding the picture on
  its base colour. The viewport puts the image on every face whatever the
  material slots say, so the export does too. The colour is white so an
  importer that tints the picture by it leaves the picture as it is;
- with the picture itself: beside an OBJ as its own file, inside an FBX.

The picture keeps its imported name, with spaces turned to underscores (an OBJ
reader stops at the first space), and a suffix (`ref_2.png`) when two pictures
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

It started as ASCII, on the theory that every importer reads it. Blender's does
not: its stock importer refuses any ASCII FBX outright, and the newer native one
rejected ours over a missing comma between wrapped array rows. Binary is what
Blender's exporter and the FBX SDK write, so it is what everything reads. Arrays
are stored uncompressed, which the format allows, so no zlib is needed.

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

`ByPolygonVertex` + `Direct` means one entry per polygon corner, in order, with
no index array. UVs are written `IndexToDirect` because that is how every other
exporter writes them, with each corner pointing at its own entry.
`ByPolygon` + `IndexToDirect` means one material index per polygon. Tests assert the array lengths match: for a cube, 24 normals × 3 floats
and 6 material indices.

### Axis and unit metadata

FBX names axes by index: 0 = X, 1 = Y, 2 = Z. The up, front and coord axes must
form a **right-handed** system, or importers mirror the model:

| Up axis | UpAxis | FrontAxis | CoordAxis |
| --- | --- | --- | --- |
| Y | 1, +1 | 2, +1 | 0, +1 |
| Z | 2, +1 | 1, −1 | 0, +1 |

The Z-up row is Blender's own system. A front sign of `+1` there is the
left-handed mistake the ASCII writer made.

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

## Validating exports

Kernel tests read the binary back node by node, checking every end offset,
property length and closing record, then assert the structure above.

The writer was also checked in Blender 4.5 and 5.0, through both the stock and
the native FBX importer, by exporting three objects (an asymmetric marker, a
rotated and non-uniformly scaled sphere, a rotated torus) under every preset,
with transforms applied and left on the node. Every vertex landed within 1e-6 of
where it should.

Image planes were checked the same way, with a 4 by 2 picture whose halves and
rows differ in colour, exported as OBJ and as FBX, triangulated or not. The FBX
files sat in a folder without the image, so the picture had to come from inside
them. In every importer the picture loaded, every corner kept its UV, the pixel
under each corner was the one the editor shows there, and the unturned plane
faced the front view upright and unmirrored. A deliberately flipped export
failed the same check. These checks are not in the repository yet. The next step is to
make it a Blender headless harness:

```bash
blender --background --python validate.py
```

importing exported fixtures and asserting vertex positions, face counts,
material slots and object count, turning "does the FBX work?" into an automated
test rather than a manual inspection.
