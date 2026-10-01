# Export

OBJ first, then ASCII FBX. Both live in `src/kernel/io/` and import nothing from
the browser.

## Why OBJ was built first

OBJ is simple enough to read by eye. Building it first gave the kernel a
known-good interchange target to validate vertex order, winding, normals and
material assignment against, before adding FBX's complexity on top. If a mesh
is wrong in OBJ, the bug is in the kernel, not the writer.

## Axis and unit presets

The editor models in metres: one unit is one metre, which is what a fresh
primitive measures across. The user should not have to understand coordinate
conventions to produce a valid export, so picking a target engine sets everything:

| Preset | Up axis | Units | Scale |
| --- | --- | --- | --- |
| Unity | Y-up | Metres | 1 |
| Unreal | Z-up | Centimetres | 100 |
| Blender | Z-up | Metres | 1 |
| Maya | Y-up | Centimetres | 100 |

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
| Apply modifiers | Always on. The evaluated mesh is what gets exported |
| Triangulate | Splits n-gons before writing |
| Per-vertex normals | Emits smoothed normals on faces marked smooth, flat face normals otherwise |
| Include UVs | Emits a UV layer (see below) |
| Selection only | Restricts to selected objects |

Exports operate on a **clone**. The document's own mesh is never modified by an
export: triangulating for a game engine must not alter what the user is editing.

## UVs

There is no texture pipeline, but exports still emit a UV layer: importers in
Unity and Unreal warn or fail on meshes without one. Every face gets a **box
projection** from its dominant axis, enough to keep downstream tools happy and
to give a sane starting point for unwrapping elsewhere.

## OBJ

Standard, with one file for geometry and one for materials.

- `v` / `vt` / `vn` with **1-based** indices.
- One normal per face (or per smooth vertex), referenced by every corner.
- `o` per object, `usemtl` whenever the material changes.
- A matching `.mtl` with `Kd` base colours.

The importer accepts negative indices (counting back from the last vertex) and
all three face-token formats (`v`, `v/vt`, `v//vn`, `v/vt/vn`). Positions are
collected globally before faces are built, because OBJ indices address the whole
file rather than the current group.

## ASCII FBX 7.4

The highest-risk part of the build. Three.js has no FBX exporter and the binary
format is Autodesk's, so the workable route is **ASCII FBX version 7400**, which
Unity, Unreal, Blender, Maya and 3ds Max all import. Binary is a later
optimisation, not a requirement.

### Structure emitted

```text
FBXHeaderExtension    FBXVersion 7400, timestamp, creator
GlobalSettings        UpAxis, UpAxisSign, FrontAxis, CoordAxis, UnitScaleFactor
Definitions           accurate object counts
Objects               Geometry, Model and Material per mesh
Connections           Geometry → Model, Model → root (0), Material → Model
```

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
| `LayerElementUV` | `ByPolygonVertex` | `Direct` |
| `LayerElementMaterial` | `ByPolygon` | `IndexToDirect` |

`ByPolygonVertex` + `Direct` means one entry per polygon corner, in order, with
no index array. `ByPolygon` + `IndexToDirect` means one material index per
polygon. Tests assert the array lengths match: for a cube, 24 normals × 3 floats,
24 UVs × 2 floats, and 6 material indices.

### Axis metadata

FBX names axes by index: 0 = X, 1 = Y, 2 = Z. `GlobalSettings` declares both the
converted `UpAxis` and `OriginalUpAxis` so importers that respect the metadata
and importers that assume a convention both land in the same place.

### Object ids

Ids must be unique and non-zero. `0` is reserved for the scene root, which is
what `C: "OO",<modelId>,0` connects each model to.

## Validating exports

Kernel tests cover the writer's structure. The remaining step, not built yet,
is a Blender headless harness:

```bash
blender --background --python validate.py
```

importing exported fixtures and asserting vertex counts, face counts, material
slots, bounding box and object count, turning "does the FBX work?" into an
automated test rather than a manual inspection.
