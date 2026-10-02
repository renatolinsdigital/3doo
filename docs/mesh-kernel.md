# The mesh kernel

The BMesh data structure and how each modelling operation uses it.

## Why not triangles

A triangle soup cannot answer "which faces share this edge?" or "what is the next
edge around this vertex?". Without those answers, loop cut, bevel, dissolve and
loop select are all either impossible or unreliable. So the kernel stores a
BMesh-style half-edge structure and triangulates only at the display and export
boundary.

## The structure

```ts
Vertex { id, co, edges[], selected, normal }
Edge   { id, v0, v1, loops[], selected, sharp }
Loop   { id, vert, edge, face, next, prev, uv }
Face   { id, loop, normal, materialIndex, selected, smooth }
```

A **loop** is one corner of one face: the pairing of a vertex with the edge
leaving it. A face's loops form a cycle (`loop.next` walks the winding order),
and an edge's `loops` array is its *radial set*: the loops of every face using
that edge.

```text
        v1
        ●───────────────●  v2
        │  loop1 →      │
        │               │        face.loop → loop0 → loop1 → loop2 → loop3 ─┐
        │        face   │                      ▲                            │
        │               │                      └────────────────────────────┘
        ●───────────────●
        v0   ← loop3    v3

  edge(v0,v1).loops = [ this face's loop, the neighbouring face's loop ]
```

### One deliberate simplification

Blender threads the radial set as a linked cycle. This kernel uses a plain array.
It carries the same information, cannot desynchronise from itself, and the O(1)
splice Blender gains is not worth the class of bugs it costs at this scale. Every
query (`edgeFaces`, `isBoundaryEdge`, `isNonManifoldEdge`) reads through it.

### Element storage

Verts, edges and faces live in insertion-ordered `Map`s keyed by a monotonic id.
Iteration is therefore deterministic across runs, which is what lets kernel tests
assert exact counts and lets serialization produce stable output.

## Invariants

`BMesh.validate()` returns a list of problems rather than a boolean, so a failing
test reports *what* broke. It checks that:

- every vertex's `edges` contain it,
- every edge references live vertices and is non-degenerate,
- every loop cycle is closed (`loop.next.prev === loop`),
- every loop is present in its edge's radial set,
- every loop carries the edge that actually joins its vertex to the next,
- no face visits a vertex twice.

Every topology test in the suite ends with `expect(mesh.validate()).toEqual([])`.

## Operations

All of these live in `src/kernel/ops/`. Each returns the geometry it created so
the caller can set selection.

### Extrude (`extrude.ts`)

Region extrude is *detach and wall*:

1. Find the region's boundary edges: edges with exactly one adjacent face inside
   the region.
2. Duplicate the vertices that must detach (boundary-ring vertices, plus any
   vertex touching a face outside the region). Interior vertices are moved, not
   duplicated.
3. Rebuild the region faces on the duplicates and delete the originals.
4. Add a quad wall along each boundary edge, wound against the region face so
   normals stay consistent.
5. Drop the interior edges that were orphaned.

`individual: true` runs the same routine per face along that face's own normal.

### Inset (`inset.ts`)

Topologically identical to extrude, on the same `detachRegion` machinery. Only the
placement rule differs. Instead of moving along the normal, each duplicated
vertex slides inward within the face plane along the **miter** of its two
boundary directions, so the border keeps a constant width. See
[math.md](math.md#mitering).

### Bevel (`bevel.ts`)

The hardest operation, and the one with the most explicit scope.

Each face adjacent to a beveled edge is offset inward along that edge and mitered
at its corners. Every corner produces exactly one replacement point:

| Corner | Result |
| --- | --- |
| Both edges beveled | One mitered point |
| One edge beveled | One point on the *unbeveled* edge, which splits it |
| Neither, but chamfers arrive on both sides | Corner is cut away |
| Neither | The vertex survives |

Then each beveled edge gets a profile strip between the two rails, and vertices
where several chamfers meet get a cap polygon found by walking the face fan.

With `segments > 1` the strip is subdivided along a quadratic Bézier whose control
point is the original corner, which rounds the profile.

**Known limitation:** a bevel terminating against three or more unbeveled edges
can close with a coplanar cap. The result stays a valid closed manifold, but it
carries a zero-volume flap.

Verified on a cube with all 12 edges beveled: 24 vertices, 26 faces, 48 edges,
Euler characteristic 2.

### Loop cut (`loopcut.ts`)

Walks the ring of quads the starting edge passes through, stopping at n-gons,
triangles and boundaries, exactly where a loop cut has to stop. Every ring edge
is split at the same parameters, measured from a consistent side so the cuts line
up, and each quad becomes a strip of quads.

### Subdivide (`subdivide.ts`)

One Catmull-Clark topology step: every selected face becomes one quad per corner,
using shared edge points and a new face point. Faces bordering the selection keep
their shape but gain the new edge points, so the mesh stays watertight.

With `smooth > 0`, edge points move toward the average of their endpoints and
adjacent face centres, and original corners are relaxed by
`(F + 2R + (n-3)V) / n`, but only corners whose entire face fan is selected, so a
partial subdivision cannot distort the surrounding surface.

Note that face points sit *on* the face centres, so subdividing a cube does not
shrink its bounding box; what shrinks is the corners.

### Subdivide edges (`subdivide.ts`)

`subdivideEdges` puts `cuts` evenly spaced vertices along each edge.

The new points cannot just be dropped onto the edge. A face's ring is its own
list of corners, so a face left alone would still span the old corners, and the
new vertex would sit on a seam nothing references. Every face touching a split
edge is therefore rebuilt with the new points spliced into its ring.

Direction matters when splicing. A loop traverses its edge starting from
`loop.vert`, which runs `v1 -> v0` for one of the two faces sharing the edge, so
that face takes the points in reverse order.

Wire edges have no face to rebuild, so each is replaced by its own chain of
segments.

### Loop chains (`chains.ts`, `relax.ts`, `circle.ts`, `space.ts`)

Three operators reshape a loop that is already in the mesh: relax, space and
circle. All three start from `findChains`, which reads the selection by
counting, for each selected vertex, how many of its neighbours are selected:

| Selected neighbours | The vertex is |
| --- | --- |
| Two | Part of a chain |
| One | An end, which the chain is measured against |
| Any other number | Loose, with no loop through it |

Walking the links from either end gives each chain in order, whether it closes
on itself, and which vertices pin its ends. A chain along an open border also
keeps a copy of that border as it was, since there is no surface past a border
to project back onto.

Each operator then does one thing with the chains:

- **`relaxVerts`** pulls each vertex to the midpoint of its neighbours, spreads
  the chain evenly along the resulting line, and drops every vertex back onto
  the faces it came from. The loop slides across the shape instead of sinking
  into it.
- **`spaceVerts`** does only the spreading, so the loop keeps every bend.
- **`circleVerts`** fits a plane and a circle. Newell's normal over a
  unit-sized copy of the loop gives the plane, and an algebraic least squares
  fit gives the centre and radius on it. Each vertex then moves to that radius
  along the direction it already sits in.

The circle is a least squares fit, not the centroid plus a mean radius, because
an arc, or a loop crowded down one side, sits off its own centroid. A circle
centred there would swing the whole selection sideways.

### Merge by distance (`merge.ts`)

The primary automatic topology cleanup. A spatial hash buckets vertices by
`threshold`-sized cells, first occupant wins, and `weldVerts` rewrites every
affected face, dropping any that collapse below three distinct corners.

`planMergeByDistance` builds the mapping without touching the mesh, which is what
lets the merge dialog show a live "N vertices will be removed" count that matches
exactly what committing does.

### Connect (`connect.ts`)

Runs an edge between two vertices (<kbd>J</kbd>). When both sit on the same face
it *splits* that face rather than laying an edge across it: a bare edge through a
face divides nothing, so the result would look cut while still shading and
extruding as one surface. Walking the face ring both ways from one vertex to the
other gives the two halves, and because each keeps the parent's vertex order the
split faces inherit its winding for free.

Vertices with no face in common (two loose verts, or corners of separate islands)
get a plain edge instead, which is the only thing that can be meant there.
Vertices an edge already joins are refused, and that covers ring neighbours too,
since consecutive corners of a face always already have the edge between them.

### Delete and dissolve (`delete.ts`, `dissolve.ts`)

These are separate paths because they answer different questions:

- **Delete** removes geometry outright, in five modes: `verts`, `edges`,
  `faces`, `onlyFaces`, `edgesAndFaces`.
- **Dissolve** removes topology but keeps the surrounding surface: the faces
  around what was removed merge into one.

#### How the UI picks a mode

<kbd>Delete</kbd> in edit mode opens the delete menu (`DeleteMenu`), whose six
entries each pass their own `mode`: `verts`, `edges` or `faces`, to `delete` or
to `dissolve`. The entry names the type, so the select mode plays no part.
`useDeleteActions` disables the entries that would change nothing: one with no
element of its type selected, a face dissolve without two selected faces that
share an edge or whose faces close off a solid (`hasDissolvableRegion`), an
edge dissolve whose edges all lie on an open border, and a vertex or edge
dissolve whose whole selection fails the 40° fold rule. A selection that fails
the rule only in part stays enabled, and the operator reports what it skipped.

<kbd>X</kbd> is the quick path and asks nothing. `useKeymap` maps the active
select mode onto the operator's `mode` param (vertex → `verts`, edge →
`edges`, face → `faces`), so it always acts on what the user sees highlighted.

The operators still take every mode they support, and
`exec('delete', { mode: 'onlyFaces' })` remains available to scripts.

#### Dissolving faces

Dissolving faces merges each connected region into one n-gon. A single selected
face is therefore a no-op: the region is torn down and rebuilt from the same
boundary ring. The operator guards that case instead of reporting success.
Otherwise it reports counts taken from the mesh before and after, so the status
line never claims work the mesh did not do.

#### The fold problem, and the angle limit

Dissolve edits topology, not geometry: the merged n-gon keeps every vertex
exactly where it was. Merging two faces that meet at a sharp angle therefore
makes a **folded** face, which nothing downstream can represent:

- it gets one averaged normal that matches neither half,
- ear clipping projects it onto a plane it does not lie near,
- OBJ and FBX record it as one flat polygon.

Dissolving a cube edge, unguarded, gives exactly that: a valid but folded
six-vertex face whose shading looks broken. A vertex folds even more easily,
since a corner gathers three or more faces at once: a cube corner's three
perpendicular faces collapse into one badly folded n-gon.

So the operator filters the selection first:

- edges through `isDissolvableEdge`,
- vertices through `isDissolvableVert`, which checks every pair of faces in the
  vertex's fan.

Anything whose faces fold past `DISSOLVE_ANGLE_LIMIT_DEGREES` (40°, or the
`angle` param) is skipped, and the status line says how many. Gentle curvature
still passes: a 24-segment cylinder's 15° side seams dissolve fine, which is
what the operation is for.

The limit lives at the operator boundary, not in the kernel, on purpose. The
kernel primitives must merge whatever they are handed, since removing a vertex
*means* merging its fan. A script calling them directly still gets the
unconditional merge.

#### Vertices along a path are exempt

`isDissolvableVert` exempts vertices with two edges or fewer. A vertex only
forces a merge when it sits at a *corner*, where dropping it would leave a
hole. A vertex lying along a path, such as the midpoint left by subdividing an
edge, merges nothing: every face using it drops it from its ring and keeps its
own shape, so the angle between those faces does not matter. An angle guard
there would refuse the most ordinary case there is, undoing an edge subdivision
on a cube. `dissolveVerts` takes the matching path, trimming the vertex out of
each face's ring instead of merging the faces.

#### Implementation

- **`dissolveEdge`** merges the two faces sharing an edge by rotating both rings
  and splicing them.
- **`dissolveFaces`** does *not* dissolve interior edges one at a time. The last
  interior edge of a fan always ends up with both loops on the same face, which
  no pairwise merge can resolve. Instead it rebuilds each connected region's
  outline directly, chaining boundary loops in winding order, so the result is
  correctly oriented for free.
- **`dissolveVerts`** routes a corner vertex's fan through the same path, for
  the same reason. An interior vertex is not on the outline, so the merge drops
  it for free. A vertex on an open boundary survives the merge and is then
  trimmed out of the one face left.

When pruning edges the region no longer uses, only edges *interior* to the
region may go: the boundary edges are the merged face's own ring. Pruning every
edge left without a loop would also take boundary edges that no outside face
shares. On an open mesh (a grid, a plane) that deletes the ring's vertices out
from under the new face, leaving edges pointing at dead vertices. The rebuilt
face is also added before loose vertices are swept, so the ring is never
briefly orphaned.

### Normals (`normals.ts`)

`recalculateNormals` is two stages, and both matter:

1. Breadth-first across each connected shell, flipping any neighbour that
   traverses a shared edge in the *same* direction as its neighbour, and two
   consistently wound faces always traverse it oppositely.
2. Compute the shell's signed volume and flip the whole shell if it is inside
   out. Consistency alone still permits a uniformly inverted shell, which is
   exactly the case that ruins an export.

### Sharp edges (`normals.ts`, `BMesh.cornerNormals`)

`edge.sharp` marks where smooth shading should break. It is Blender's Mark
Sharp: a shading flag that moves no geometry. `markSharp` sets or clears it, and
the `markSharp` operator runs that over the selected edges, refusing when
nothing would change.

**How a sharp edge changes shading.** A smooth face normally shades through
`vert.normal`, the area-weighted average of every face around the vertex.
`cornerNormals` splits that fan of faces wherever it crosses a sharp edge,
averages each side on its own, and returns a normal for each corner that
differs, keyed by loop id. The display buffers and the FBX exporter read it in
place of the vertex normal.

**A crease has to run through a vertex to split it.** The sides of a fan are
found by joining faces across every edge that is *not* sharp. So:

- At the last vertex of a crease that stops partway across a surface, the faces
  can still be joined the long way round, and the fan stays whole. The shading
  break fades out over the crease's last edge. Blender behaves the same way.
- A border vertex has no long way round, so a single sharp edge running in from
  the border does split it.

**Cost.** Only vertices on a sharp edge are visited, and a fan that comes out
whole writes nothing. A mesh with no sharp edges pays one pass over its edges
and nothing else.

**Keeping the mark through edits.** A new edge starts out smooth, so every
operation that cuts or rebuilds edges has to pass the mark on:

| Mechanism | Used by |
| --- | --- |
| `carrySharp` | Subdivide (edges and faces, and through it the subdivision modifier), loop cut, the mirror's bisect |
| `weldVerts` re-marks the edges it rebuilds around a welded vertex | Merge by distance, auto merge, the mirror and array seams |
| `copySharp` | Mirror, array and solidify (see [Modifiers](#modifiers)) |

### Fill and bridge (`fill.ts`)

`edgeLoopsFrom` chains selected edges into ordered rings; both fill and bridge
build on it. Fills are wound against the surrounding surface so their normals
agree with it. Bridge aligns the second loop by testing every rotation and both
directions, picking the one with the least total distance. Without that, bridging
two rings built in opposite directions folds the band over itself.

### Selection walks (`select.ts`)

`selectEdgeLoop` continues through a valence-4 vertex along the one edge sharing
no face with the current edge. Any other valence ends the loop, which is why
Alt+click stops at poles, and why the loop on an open tube's rim is a single
edge.

## Modifiers

`evaluateModifiers` clones the base mesh once and pipes it through each enabled
modifier. The object being edited is never touched, which is what makes the stack
non-destructive. `applyModifier` bakes a single one into the mesh.

### Mirror

- **Reflection** reverses winding, because a reflection inverts handedness.
  Wire edges are copied by hand, since they carry no loop for the face pass to
  follow.
- **The plane** passes through the object's own origin, or through the 3D
  cursor when `origin` is `'cursor'`. The cursor arrives through
  `ModifierContext` already converted to the object's local frame, because that
  is the only coordinate system the kernel knows. Clipping, bisect and the seam
  weld all measure from that plane, not from zero.
- **The merge limit** is a distance from the *mirror plane*, not a general
  weld. Only a vertex sitting on the seam absorbs its own reflection, so
  geometry that happens to be dense elsewhere is left intact.
- **Bisect** cuts the faces that straddle the plane instead of dropping them
  whole. Without it, the reflection lands back on top of the uncut half, and the
  result is doubled geometry with opposing winding.

### Array, solidify and subdivision

- **Array** repeats the mesh along an offset built from the bounding box, a
  constant, or the two added together.
- **Solidify** offsets a shell along vertex normals, reverses it, and fills rim
  quads along the boundary edges, which it captures *before* the shell is added.
- **Subdivision** runs `subdivideFaces` across every face.

Mirror, array and solidify build their copies a face at a time, and the edges
those faces bring start out smooth. So each one marks the copy of every sharp
edge afterwards (`copySharp`). Solidify's rim stays smooth: it is new geometry,
not a copy of a crease.

### Weld

Weld is `mergeByDistance` run over every vertex in the mesh. There is no
selection involved, because a modifier has none. That is the whole difference
between it and the Merge by Distance operator in the Operations panel.

It exists for the seams the rest of the pipeline leaves behind: an array whose
copies touch but do not share vertices, a mirror with merge switched off, an OBJ
that split its vertices per face. Ordering matters, so it belongs *below* the
modifier whose output it is cleaning up.

Two things about the distance are worth knowing, because both look like bugs:

- **The default of 0.001 usually changes nothing.** It is sized to catch
  vertices already stacked on top of each other, which is what a seam is. The
  silhouette is meant to stay put; if the shape moves, the distance is too big.
- **Welding is not transitive.** A row of vertices 0.6 apart welded at 1.0 keeps
  every other one rather than collapsing to a point: the spatial hash lets the
  first occupant of each cell win, and a vertex that has been absorbed is no
  longer a candidate to absorb the next.

A distance approaching the size of the mesh removes it altogether: every face
falls below three distinct corners, and `weldVerts` drops those, leaving nothing
for the surviving vertices to belong to.
