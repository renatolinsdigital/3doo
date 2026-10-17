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

### Knife (`knife.ts`)

`knifeCut` takes runs of `KnifePoint`s: a vertex, a point part of the way along
an edge, or a point inside a face. Each straight piece between two neighbouring
points of a run lies inside one face, which `knifeSegmentFace` finds as the face
both ends touch whose outline holds the middle of the piece. That test is what
turns away a piece cutting across the outside of a face that bends back on
itself, and a piece that only runs along an existing edge adds nothing.

The cut is then made face by face, and the order of the runs makes no
difference:

1. **Pieces meet.** Inside each face, two pieces that cross get a new point
   where they cross, and a piece ending on another splits that one where it
   lands. Both are worked in 2D, on the plane the face's corners average to.
2. **Edges split.** Every edge with a point on it is split there, and each face
   it borders is rebuilt with the new corners in the order it walks the edge,
   UVs interpolated along it and sharp marks carried onto the pieces.
3. **Faces divide.** The pieces inside a face form a small net. Every path
   through it from a vertex on the face's border, through vertices inside the
   face, to another border vertex divides the face in two; dividing puts the
   path's inner vertices on a border, which is what lets the middle of a cross
   divide the face again. Both halves keep the face's winding, material and
   smoothing, and the inner vertices take UVs from mean value coordinates, which
   reproduce a flat layout such as an image plane's exactly.

A face is one ring of corners and cannot hold a hole, so before dividing,
`bridgeLoops` joins every closed loop of the net that reaches the face's border
in fewer than two places to that border. It trims the net's free ends to find
the loops, then adds the shortest bridges from a loop vertex to a corner, or to
a point the cut has on the border, that touch neither the border nor any piece.
The path in along one bridge, round the loop and out along the other divides the
face, the rest of the loop divides again, and what the loop encloses is left a
face of its own. The bridges are left out of the edges the cut reports, so the
operator selects only what was drawn. A loop with no room for its bridges stays
loose.

What is left of the net, a line that stops inside a face, becomes loose edges:
a face cannot hold a slit either. A point inside a face that
no piece reached is removed. Points within `1e-6` of each other along an edge,
or inside a face, are one point, so a run ending where it began closes, and an
edge point within `1e-4` of an end is that end's vertex.

How a click becomes a point, and what a line between two clicks crosses, is a
question of the camera, so it lives in the viewport (see
[rendering.md](rendering.md#the-knife)).

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

Joins the selected vertices one after the next (<kbd>J</kbd>), like Blender's
Connect Vertex Path. The order is the click order (`selectSeq`) when every
vertex has a distinct stamp; otherwise `connectionOrder` chains them from the
vertex farthest from their centroid, each to the nearest one left.

Each pair is joined along the *straight line* between them. `linePath` walks
from face to face along that line, always forward: its nodes are vertices on the
line (within `ON_LINE` of its length) and the points where it crosses edges, and
its steps are straight pieces inside one face (checked with `knifeSegmentFace`,
which also rejects pieces that leave a concave face). Two corners of one face
reach each other in a single step whenever the line between them stays inside
it, even when the face is not flat.

When the walk cannot reach the far vertex, the line leaves the surface: through
the air, through the inside of a solid, or out of a concave face. The pair then
gets a plain edge and no face is touched. An earlier version followed the
surface instead, walking a plane round a solid like Blender's Connect Vertex
Path, but that cut faces well away from the line the user drew between the two
vertices.

Every path is found on the mesh as it stands and handed to `knifeCut` as one
run per pair, so the knife does the cutting: each crossed edge is split (both
faces beside it gain the vertex, so no T-junction is left), every face is divided
along the path, and paths that cross inside one face meet at a shared vertex. A
crossing within `EDGE_END` of an edge's end is taken as that end vertex rather
than leaving a sliver beside it.

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

#### Delete loose

`deleteLoose` keeps one piece of the mesh and deletes the rest. Pieces are
found by flood filling over edges (`selectLinked`), so a stray vertex, a wire
edge and a face floating on its own are each a piece. The one kept has the
most vertices, edges and faces counted together, not the most vertices: a
long chain of wire edges has more vertices than a cube and is still the
debris. A tie keeps the piece found first, which is the one built first.

It ignores the selection, unlike Blender's Delete Loose, which removes
geometry with no face attached. Here a whole floating box goes too, since the
question asked is which piece is the model.

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
  and splicing them. `dissolveEdges` then drops each end left with two edges in
  a straight line, rebuilding the faces on either side without it. Left in
  place, such a point shapes nothing, yet extrude walls each side of it
  separately and the dissolved edge reappears along the walls. An end where the
  outline turns stays, since dropping it would change the face's shape.
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

Fill traces the empty regions the mesh's open edges (boundary or loose) close
around, and fills each one the selection runs all the way round. The walk keeps
the uncovered side of each edge on its left and, where several open edges meet,
takes the first one clockwise from the edge it came in on, in the plane of the
vertex's faces. That keeps it to the smallest region, so loose knife lines
across a hole divide it into a face per part. Chaining edges by whichever came
next strung parts of different regions into one ring. Loose lines that lead
nowhere are pruned first. A sheet's outline traces as a region too, but winds
against the faces along it where a hole winds with them, and is skipped. The
rings come out wound the way the surface faces, so their normals agree with it.

The faces' plane is the wrong one where they stand square to an open edge. A
gap in the side of an extruded outline is the usual case: the loose edge down
the wall between two gaps meets the top and bottom faces at right angles, their
plane flattens it to a point, and the walk carried on along the outline instead
of turning down the wall. Two walks into that vertex then leave by the same
edge, which no set of regions does. So wherever that happens, the plane the
open edges at the vertex span (`spannedNormal`) takes over, facing whichever
way gives every walk its own way out.

A selected face folded flat back over the faces around it (back to back with a
face along every edge, on the same side, and onto at least two different faces)
is looked past. The old outline cap was one: it put a second face on every hole
edge, so nothing looked open. Fill removes such a face once a region it bordered
is filled, and leaves one that hid no hole.

After the walk, any ring the selected open edges still close gets a face too
(`selectedRings`). Each selected edge is closed by the shortest way round
through the others, so a loose edge between two holes ends the ring of each,
and the rings fill shortest first. The new face is wound the way most of the
faces along it agree on, and the outline test above still applies. The walk can
lose its way, around faces flipped against each other for one, and a ring
plainly selected should never be refused for that.

`edgeLoopsFrom` chains selected edges into ordered rings and says whether each
closed. Bridge uses it, and so does fill's fallback in vertex and edge mode:
when no region fills and the selection is only open edges, an open run gets a
face across its ends, the way Blender's F makes a face from a chain. Bridge aligns the second loop by testing every rotation and both
directions, picking the one with the least total distance. Without that, bridging
two rings built in opposite directions folds the band over itself.

### Make planar (`planar.ts`)

`quadBend` measures how far a quad bends as the crease between its two
triangles, along whichever diagonal leaves the smaller one. The other
diagonal of a concave quad runs outside the face, and its triangles fold back
over each other, so it is never the one that counts. A triangle thinner than
`SLIVER` has no reliable normal and counts as flat. `isNonPlanarQuad` holds
that against `PLANAR_TOLERANCE_DEGREES`, and the viewport's non-planar overlay
reads the same test.

`makeQuadsPlanar` flattens the quads among the faces it is given and leaves
triangles and n-gons alone. Blender's Make Planar Faces projects each face
onto its own plane, averages the positions a shared vertex is pulled to, and
repeats. That flattens a lone quad in one pass, but it settles neighbours only
by passing the correction back and forth between them, so a patch of quads
sharing corners takes thousands of passes. A noisy 8 by 8 grid was still bent
after 200.

So every quad is settled at once. A flat quad's diagonals cross; a bent one's
pass each other with a gap along their common normal. Moving the first and
third corners one way along that normal and the second and fourth the other
closes it, which gives one linear equation a quad in the corner movements.
Each solve finds the smallest movement of every corner that meets all of them
at once, by conjugate gradients on the quads' rows (the matrix is never
built). The normals tilt as the corners move, so a few solves are repeated
until the largest gap is under `FLAT` of the quad's size.

Two things were found the hard way:

- **The twist has to be the gap, not the volume.** The volume of the
  tetrahedron the four corners make is the obvious coplanarity test, but it is
  zero for a quad folded shut as well as a flat one. A quad bent past 90°, as a
  coarse smoothed cube has at its corners, was driven shut into a bowtie. The
  gap is zero only when the diagonals cross.
- **Each step is checked before it is kept.** A step that would leave the
  gaps larger, or turn a quad over, is halved and tried again, up to
  `MAX_HALVINGS` times.

`WORK_BUDGET` caps one call at about a second. A 10,000-quad grid bent every
which way is mostly flat after one call, and a second carries on from there.
Gently bent patches of that size finish in one.

Corners shared with faces outside the selection move too, as in Blender, so
flattening a quad can bend an unselected neighbour.

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

### Array, solidify and loop subdivide

- **Array** repeats the mesh along an offset built from the bounding box, a
  constant, or the two added together.
- **Solidify** offsets a shell along vertex normals, reverses it, and fills rim
  quads along the boundary edges, which it captures *before* the shell is added.
- **Loop subdivide** runs `subdivideFaces` across every face with one cut,
  once per level. At the default `smooth` of 0 it only adds faces and leaves the
  shape untouched: a plain grid split, not a Catmull-Clark surface. Raising
  `smooth` applies the edit-mode operator's corner relaxation, again on every
  level.

Mirror, array and solidify build their copies a face at a time, and the edges
those faces bring start out smooth. So each one marks the copy of every sharp
edge afterwards (`copySharp`). Solidify's rim stays smooth: it is new geometry,
not a copy of a crease.

### Subdivision surface

`catmullClark` builds one level over the whole mesh as a new `BMesh`, from the
cage's rings: a face point per face, an edge point per edge, a moved corner per
vertex, and one quad per face corner. It does not go through `subdivideFaces`,
because the stack runs on every edit and building from flat rings is far
cheaper than cutting faces out of a mesh in place. Level 6 on a cube (24,576
faces) evaluates in about 140 ms.

- **Catmull-Clark** places the points by the standard rules, the ones Blender's
  Subdivision Surface modifier uses at its defaults. An open border is smoothed
  along itself alone (`(a + 6v + b) / 8`). A vertex where borders meet, or on a
  wire or non-manifold edge, does not move.
- **Simple** (`catmullClark: false`) takes midpoints and centres and leaves the
  shape alone.

UVs are interpolated linearly, sharp marks carry onto both halves of the edge,
and wire edges are split in two. Sharp edges are not creases: the surface
rounds across them and only the shading breaks there. Like loop subdivide, a
level that would outgrow `MESH_BUDGET` is dropped.

Edit mode draws the cage's wire around the shaded result, as Blender does, and
leaves out the result's own edges (`drawsPreviewWire` in `ObjectView.ts`): at
any real level they would bury the surface. Object mode draws the result alone.

### Bend

Bend is the Bend mode of Blender's Simple Deform modifier, with three changes
that make it usable without an empty to steer it or a scale to apply first:

- **One modifier carries all three axes.** The bends run around X, then Y, then
  Z, each on the result of the one before, which is exactly what three
  single-axis bends stacked in that order would give.
- **The side that curls is read off the mesh.** Around each axis, the longer of
  the two sides square to it curls toward the other. Blender fixes that pairing
  per axis, which is why a plane lying flat cannot be curled up there without
  rotating an origin object first. On a tie the side lying flat curls up toward
  +Y (`SQUARE_TO`), so a cube or a square plane bends like a sheet of paper.
- **It bends the object as it is drawn.** `ModifierContext.scale` carries the
  object's scale, and `bendAround` measures, curls and writes back each vertex
  at that scale. Measured as stored, a cube scaled into a column is still a
  cube: it curled across its width, and the scale then stretched that curl
  into a leaf. A uniform scale changes nothing.

Like Blender's, the bend only moves the vertices there are and adds none: a
plane of four corners bent through 90° stays one flat face. A face curves as
far as the loops already across it let it, so the length that should curve
wants loop cuts, or a LOOP SUBDIVIDE above the bend in the stack. Slicing the
mesh into strips before bending was tried and dropped: the strips ran across
whatever loops the mesh already had, which left a sphere or a cylinder crossed
with stray edges and n-gons nobody asked for.

The angle is spread over the whole length that curls, as Blender does: the
radius is `span / angle`, so 360° wraps any length into exactly one ring and
the two ends land on each other (a WELD below the bend joins them). The centre
(the object origin, or the 3D cursor through `ModifierContext`) is where the
mesh stays put. The line through it keeps its length; what lies toward the
inside of the curl is squeezed and what lies outside is stretched.

### Twist

Twist is the Twist mode of Blender's Simple Deform modifier, carrying all three
axes the way Bend does: the twists run about X, then Y, then Z, each on the
result of the one before. About each axis, every vertex turns by
`angle * (distance along the axis from the centre) / (length of the mesh along
it)`, so one end turns the whole angle past the other however long the mesh is.
The centre (the object origin, or the 3D cursor) fixes both the line the mesh
turns about and the level that holds still. Positive angles are right-handed
(`TURNS`): anticlockwise, looking down the axis from its positive end.

It shares `drawnShape` with Bend, so the cross-section turns as it is drawn: a
cube scaled into a flat bar keeps its flat section all the way up, where turned
as stored the section would shear into a rhombus partway round. The angle is clamped to
`MAX_TWIST_ANGLE`, four full turns. Like Bend it only moves the vertices there
are, so a side twists as smoothly as the loops across it allow: four corners
and nothing between them twist into a single warped quad.

### Lattice

Lattice is Blender's Lattice modifier, and like Blender's it reads its shape
from an object of its own: a cage, which is an ordinary scene object whose
`lattice` field holds its resolution and whose mesh is the grid of points,
joined along each axis by wire edges and carrying no faces. That is what lets
the cage be shaped with everything edit mode already has (the gizmo, G, R and
S, proportional editing, snapping, undo) instead of with tools of its own.

At rest the points fill the unit cube about the cage's origin, X fastest, then
Y, then Z (`latticeRestPoints`); the cage's object scale is what stretches that
cube round a mesh. The grid is read off the order the vertices were made in,
which serialization, `cloneMesh` and undo all keep. So a cage must never gain
or lose a vertex: `exec` lets only the operators that move or pick vertices
through on one (`CAGE_OPERATORS`), auto merge skips it, and `latticePoints`
hands back null for a mesh whose count no longer matches, which leaves the
modifier passing its mesh through untouched.

The store builds the `LatticeCage` for each lattice modifier in
`modifierContext`: the points in the cage's space, and the two matrices
between that space and the shaped object's. The kernel works on offsets, each
point less where it rests, and never on positions. A vertex is taken into the
cage's space, the offsets around it are weighted by how near it lies to each,
and the sum comes back through the cage's matrix as a displacement. A cage
nobody has shaped therefore moves nothing, whatever its interpolation and
wherever the cage object stands, and a vertex no offset reaches comes back
exactly where it was rather than through two matrices and a rounding error.

The weights along each axis are one of two kinds:

- **Linear** is trilinear: each cell carries straight across from corner to
  corner, so moving a point drags exactly its own corner of the mesh.
- **Smooth** is a uniform cubic B-spline, which reaches one point past each
  end of the grid. Blender leaves those points out, which is why its outermost
  points only pull a mesh part of the way. Here they are made up by carrying
  the last step on in a straight line (`2·P₀ − P₁`), which makes the curve land
  exactly on its end points: the corners of the cage take the corners of the
  mesh with them, and a 2 by 2 by 2 cage is exactly linear.

Past the cage's sides the pull fades out over one cell's width rather than
stopping dead or running on for ever, so a cage placed round part of a mesh
shapes that part and lets the rest go smoothly. Changing the resolution
resamples a grid at the new rest points (`resampleLattice`), so the shape the
cage gives survives as closely as the new grid can hold it, exactly for any
linear pull.

The grid it resamples is not the one the last change left but the one the
cage was last shaped on by hand, which the cage's `lattice.shape` remembers
from its first change of resolution on (`latticeShape`). Resampling each grid
from the one before would wear the shape away a little every step, and a pass
through 2 points on an axis would drop everything between its ends for good.
The memory holds while the points still stand where resampling it put them,
which is checked rather than tracked, so whatever tool moves a point, the grid
as it stands becomes the shape from then on. Reset drops it.
It travels in the document, so save and undo keep it too.

A cage keeps its own origin and scale: baking them into the points would read
as the cage having been pulled out of shape, so apply transform and the origin
operations leave cages out. It takes no modifiers, joins no merge or boolean,
and stays out of exports and snapshots.

Applying a lattice modifier bakes the cage's pull into the mesh and, in the
same history step, deletes the cage, since its shape now lives in the mesh.
A cage another lattice modifier still names stays: a duplicate of the object
carries the modifier across, so two objects can read one cage.

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

### Quadify (`quadify.ts`)

`quadify` turns every face that is not a quad into quads and moves no
vertex: the new ones sit on the edges and faces they split. It is what Blender
users reach for Tris to Quads, a few loop cuts and some knife work to do by
hand after a boolean, run as one modifier. It works in four passes.

1. **Join.** Triangle pairs that make a well shaped quad (every corner between
   30° and 150°, measured on the quad itself) are joined, squarest first, so a
   triangulated grid comes back as its grid. A pair is never joined across a
   sharp edge, between two materials, or folded further than JOIN ANGLE.
2. **Merge.** Faces that are not quads are merged wherever they lie within
   0.1° of flat, so the slivers a boolean leaves on a flat face become the one
   face they really are. Quads stay out of it. A second join then takes the
   pairs that are merely convex (corners between 10° and 170°): the fan at a
   pole or a cone's tip, as kites. Equally square pairs tie, and rounding then
   decides the order, so the leftovers are re-paired along augmenting paths
   (`rematch`) rather than stranded.
3. **Parity.** A face with an odd number of corners cannot be cut into quads,
   so edges are split until none is odd. Each odd face is paired with the
   nearest other one, or with an open border, by a Dijkstra search over the
   edge a path enters each face by: crossing a quad straight costs least,
   turning inside one more, since the turn leaves a pole. A straight run is a
   loop cut. No edge is split twice, and that never strands a face: the
   corners round any region the split edges wall off add up to twice its
   edges, so every region holds an even number of odd faces.
4. **Cut.** Every ring with more than four corners, split points included, is
   cut into quads by a search over its stretches (`cutExactly`): the best cut
   from corner `s` to corner `t` is the best quad on the line between them plus
   the best cuts of what it leaves, or a star of quads round one new point in
   the middle. Quads are scored by the log of their squareness, so one bad quad
   costs more than several good ones gain. No new corner may come within 5° of
   straight; a corner the ring already has, kept between its own two sides, may
   come within 0.5°, which is what a finely divided circle needs. Rings past 40
   corners are halved along their squarest balanced diagonal first.

Some faces have no cut. A face whose ring cannot be cut is first offered rungs
(`findRungs`): from each inward corner, a line straight across to a side, ending
where the corner's perpendicular lands, so the split goes where the corner
needs it rather than in the middle. Each inward corner tries its three
shortest, with one midpoint added wherever the count has to come out even, and
the set that cuts squarest is kept; the faces across the split sides are left
for the paths to pair off. A face with no inward corner tries pairs of
midpoints, which run a loop through it. That is what turns the bent band a
boolean leaves round a box sitting turned on another into a ladder of quads,
where midpoints alone never cut it. A face nothing helps is made hard and cut
the way a
subdivision cuts it: into convex pieces (`convexPieces`), every side split, one
quad per corner round each piece's middle. Triangles are hard from the start,
since a triangle with one side split is only a quad with a straight corner; so
is a face a boolean bit a curve out of, whose inward corners no point inside it
can see past. After each round the paths are planned again around the faces
that changed. Rungs are offered for four rounds; after that a face still
without a cut is made hard, which always cuts, so the plan settles.

Quads no path reaches are never touched, so a mesh that is already all quads
comes back as it was. UVs are interpolated onto the new corners, sharp marks
carry onto both halves of a split edge, and a result that would pass
`MESH_BUDGET` is not cut at all.
