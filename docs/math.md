# Math and geometry

Conventions and the derivations that the kernel depends on. Getting any of these
backwards produces meshes that look fine until they are exported inside out.

## Coordinate system

Right-handed, **Y-up**, matching Three.js.

```text
        +Y  up
         │
         │
         └───── +X  right
        ╱
      +Z  toward the viewer
```

Cross products follow the right-hand rule:
`x̂ × ŷ = ẑ`, `ŷ × ẑ = x̂`, `ẑ × x̂ = ŷ`.

## Winding and face normals

A face's normal is determined by its vertex order: counter-clockwise when viewed
from the side the normal points toward.

Normals are computed with **Newell's method**, not a single edge cross product:

```ts
nx += (current.y - next.y) * (current.z + next.z);
ny += (current.z - next.z) * (current.x + next.x);
nz += (current.x - next.x) * (current.y + next.y);
```

Newell sums a contribution from every edge, so it works for concave and
non-planar polygons, where picking any three vertices could produce a degenerate
or inverted normal.

### The Y-up trap

Because the ground plane is XZ, a ring ordered "+X then +Z" faces **−Y**, not +Y.
Reading clockwise/counter-clockwise off a top-down sketch gets this backwards
about half the time. The reliable check is the parametric one:

For a surface `P(u, v)`, a face wound first along `+u` then along `+v` has normal
`∂P/∂u × ∂P/∂v`. Worked out for the primitives:

| Surface | Result |
| --- | --- |
| Sphere `(sinφ cosθ, cosφ, sinφ sinθ)` | `∂θ × ∂φ = sinφ · P` → outward |
| Cylinder `(r cosθ, h, r sinθ)` | `∂θ × ∂h` → **inward**; wind `+h` then `+θ` |
| Torus | `∂u × ∂v` → **inward**; wind `+v` then `+u` |

And for a ring in the XZ plane at increasing θ = `(cosθ, ·, sinθ)`: the normal is
**−Y**. So a bottom cap is written in θ order and a top cap is reversed.

Every closed primitive is covered by a test asserting that
`dot(faceCentre, faceNormal) > 0` — true for every face of a convex solid
centred on the origin, and a cheap way to catch an inverted winding.

## Triangulation

Ear clipping, at the display and export boundary only.

1. Project the polygon onto the plane defined by its normal using an orthonormal
   basis `(u, v)` built from that normal.
2. Repeatedly clip a convex corner containing no other vertex.
3. Fall back to a fan if no ear is found, so a self-intersecting face still draws
   rather than vanishing.

Quads take a fast path: split on the shorter diagonal, which avoids sliver
triangles.

The returned index triples are always wound to match the polygon's own vertex
order. When the projected polygon comes out clockwise the algorithm runs over a
reversed copy, and the output triples are flipped back — otherwise every triangle
from such a face would face backwards.

## Mitering

Inset and bevel both offset an edge inward and need the corner where two offset
edges meet.

Given unit inward directions `n₁` and `n₂` for the two edges at a corner, and a
desired offset `w`:

```text
bisector b = normalize(n₁ + n₂)
scale     = w / dot(b, n₁)          // = w / cos(θ/2)
offset    = b · scale
```

Dividing by `cos(θ/2)` is what keeps *both* edges exactly `w` from their
originals. Without it, sharp corners pull in too little and the border width
visibly varies.

`dot(b, n₁)` is clamped to a floor of 0.2, capping the miter at very sharp
corners instead of letting it shoot off to infinity.

### Inward direction

For a loop on a face, the direction pointing into the face from its edge is:

```ts
inward = normalize(cross(face.normal, normalize(next.vert.co - vert.co)))
```

For a correctly wound face this always points at the interior.

### Bevel termination

Where exactly one of a corner's two edges is beveled, the chamfer must land on
the other edge. The distance along the unbeveled direction `d` at which the
offset line is met is:

```text
t = w / dot(d, inward)
```

again with `dot` floored at 0.2, and clamped to 45% of the edge length so the
split can never pass the midpoint.

## Transforms

Column-major 4×4 matrices, matching WebGL and Three.js element order.

Euler rotations are XYZ. `composeMatrix` builds translation · rotation · scale
directly rather than multiplying three matrices.

### Normal matrix

Transforming a normal by the model matrix is wrong under non-uniform scale. The
correct transform is the inverse transpose of the upper 3×3. For `M = R · S`:

```text
(R · S)⁻ᵀ = R⁻ᵀ · S⁻ᵀ = R · S⁻¹
```

since `R` is orthogonal and `S` is diagonal. So `normalMatrix` composes the same
rotation with a *reciprocal* scale — no general 4×4 inversion needed.

## Proportional editing falloff

Given normalised proximity `t` in `[0, 1]` (1 at the selection, 0 at the radius):

| Curve | Function |
| --- | --- |
| Smooth | `t²(3 − 2t)` — smoothstep |
| Sphere | `√(1 − (1 − t)²)` |
| Root | `√t` |
| Linear | `t` |
| Sharp | `t²` |
| Constant | `1` where `t > 0` |

Distances are measured from where the selection *started*, captured before
anything moves — otherwise the falloff would chase the geometry as it is dragged.

## Signed volume

Used to decide whether a closed shell is inside out:

```text
6V = Σ over triangles of  a · (b × c)
```

Negative means the winding faces inward.

## Export axis conversion

Converting from this editor's Y-up space to a Z-up target maps our `+Y` onto
their `+Z` and our `+Z` onto their `−Y`:

```ts
(x, y, z) → (x, −z, y)
```

This preserves handedness and leaves the model facing forward. See
[export.md](export.md).
