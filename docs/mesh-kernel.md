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
and an edge's `loops` array is its *radial set* — the loops of every face using
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

### Extrude — `extrude.ts`

Region extrude is *detach and wall*:

1. Find the region's boundary edges — edges with exactly one adjacent face inside
   the region.
2. Duplicate the vertices that must detach (boundary-ring vertices, plus any
   vertex touching a face outside the region). Interior vertices are moved, not
   duplicated.
3. Rebuild the region faces on the duplicates and delete the originals.
4. Add a quad wall along each boundary edge, wound against the region face so
   normals stay consistent.
5. Drop the interior edges that were orphaned.

`individual: true` runs the same routine per face along that face's own normal.

### Inset — `inset.ts`

Topologically identical to extrude — the same `detachRegion` machinery — only the
placement rule differs. Instead of moving along the normal, each duplicated
vertex slides inward within the face plane along the **miter** of its two
boundary directions, so the border keeps a constant width. See
[math.md](math.md#mitering).

### Bevel — `bevel.ts`

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
carries a zero-volume flap. Tracked in `TODO.txt`.

Verified on a cube with all 12 edges beveled: 24 vertices, 26 faces, 48 edges,
Euler characteristic 2.

### Loop cut — `loopcut.ts`

Walks the ring of quads the starting edge passes through, stopping at n-gons,
triangles and boundaries — exactly where a loop cut has to stop. Every ring edge
is split at the same parameters, measured from a consistent side so the cuts line
up, and each quad becomes a strip of quads.

### Subdivide — `subdivide.ts`

One Catmull-Clark topology step: every selected face becomes one quad per corner,
using shared edge points and a new face point. Faces bordering the selection keep
their shape but gain the new edge points, so the mesh stays watertight.

With `smooth > 0`, edge points move toward the average of their endpoints and
adjacent face centres, and original corners are relaxed by
`(F + 2R + (n-3)V) / n` — but only corners whose entire face fan is selected, so a
partial subdivision cannot distort the surrounding surface.

Note that face points sit *on* the face centres, so subdividing a cube does not
shrink its bounding box; what shrinks is the corners.

### Subdivide edges — `subdivide.ts`

`subdivideEdges` puts `cuts` evenly spaced vertices along each edge. The points
cannot simply be dropped onto the edge: a face's ring is its own list of corners,
so every face touching a split edge is rebuilt with the new points spliced into
its ring — otherwise the face would still span the old corners and the vertex
would sit on a seam nothing references. A loop traverses its edge from
`loop.vert` onwards, which is `v1 -> v0` for one of the two faces sharing it, so
that side takes the points reversed. Wire edges have no face to rebuild and are
replaced by their own chain of segments instead.

### Merge by distance — `merge.ts`

The primary automatic topology cleanup. A spatial hash buckets vertices by
`threshold`-sized cells, first occupant wins, and `weldVerts` rewrites every
affected face, dropping any that collapse below three distinct corners.

`planMergeByDistance` builds the mapping without touching the mesh, which is what
lets the merge dialog show a live "N vertices will be removed" count that matches
exactly what committing does.

### Connect — `connect.ts`

Runs an edge between two vertices (<kbd>J</kbd>). When both sit on the same face
it *splits* that face rather than laying an edge across it: a bare edge through a
face divides nothing, so the result would look cut while still shading and
extruding as one surface. Walking the face ring both ways from one vertex to the
other gives the two halves, and because each keeps the parent's vertex order the
split faces inherit its winding for free.

Vertices with no face in common — two loose verts, or corners of separate islands
— get a plain edge instead, which is the only thing that can be meant there.
Vertices an edge already joins are refused, and that covers ring neighbours too,
since consecutive corners of a face always already have the edge between them.

### Delete and dissolve — `delete.ts`, `dissolve.ts`

Kept as separate paths because they answer different questions.

- **Delete** removes geometry outright, in five modes.
- **Dissolve** removes topology while preserving the surrounding surface.
  Dissolving *faces* merges a connected region into one n-gon, which means a
  single selected face is a no-op: the region is torn down and rebuilt from the
  same boundary ring. The operator guards that case rather than reporting
  success, and otherwise reports counts taken from the mesh before and after, so
  a status line never claims work the mesh did not actually do.

The UI exposes them only as keys, not as panel sections: <kbd>X</kbd> deletes and
<kbd>Delete</kbd> dissolves. Neither asks which element type to act on — the
handler in `useKeymap` maps the active select mode onto the operator's `mode`
param (vertex → `verts`, edge → `edges`, face → `faces`), so the keys always
act on the elements the user can currently see highlighted. The operators still
take every mode they support; only the two keyboard paths are constrained this
way, and `exec('delete', { mode: 'onlyFaces' })` remains available to scripts.

Dissolve is a *topology* edit, not a geometry one: the merged n-gon keeps every
vertex exactly where it was. Merging two faces that meet at a sharp angle
therefore produces a **folded** face, and nothing downstream can represent one —
it gets a single averaged normal matching neither half, ear-clipping projects it
onto a plane it does not lie near, and OBJ/FBX record it as one flat polygon.
Dissolving a cube edge that way used to yield exactly that: a valid but folded
six-vertex face whose shading looked broken.

The same fold happens when dissolving a *vertex*, and more easily, since a
corner gathers three or more faces at once — a cube corner's three mutually
perpendicular faces collapse into one badly folded n-gon. `isDissolvableVert`
applies the same limit across every pair in the fan.

It exempts vertices with two edges or fewer, though, and that distinction is the
whole point: a vertex only forces a merge when it sits at a *corner*, where
dropping it would leave a hole. One lying along a path — the midpoint left by
subdividing an edge — merges nothing. Every face using it simply drops it and
keeps its own shape, so however sharply those faces meet is irrelevant. Guarding
it by angle refused the most ordinary case there is: undoing an edge subdivision
on a cube. `dissolveVerts` takes the matching path, trimming the vertex out of
each face's ring instead of merging the faces together.

So the *operator* filters selected edges through `isDissolvableEdge` and
selected vertices through `isDissolvableVert` first,
skipping any whose faces fold past `DISSOLVE_ANGLE_LIMIT_DEGREES` (40°, or the
`angle` param) and saying how many it skipped. The limit sits at the operator
boundary rather than in the kernel deliberately: the kernel primitives have to
merge whatever they are handed — removing a vertex *means* merging its whole fan
— and a script calling them directly still gets the unconditional merge.
Gentle curvature stays mergeable — a 24-segment cylinder's 15° side seams
dissolve fine, which is what the operation is actually for.

`dissolveEdge` merges the two faces sharing an edge by rotating both rings and
splicing them. `dissolveFaces` does *not* dissolve interior edges one by one:
the last interior edge of a fan always ends up with both loops on the same face,
which no pairwise merge can resolve. Instead it rebuilds each connected region's
outline directly, chaining boundary loops in winding order so the result is
correctly oriented for free. `dissolveVerts` routes a vertex's fan through the
same path for the same reason, and an interior vertex is not on the outline, so
merging drops it from the ring for free; a vertex on an open boundary survives
the merge and is trimmed out of the one face left instead.

When pruning the region's now-unused edges, only the ones *interior* to it may
go — its boundary edges are the merged face's own ring. Removing every edge left
without a loop also took those whenever no face outside the region shared them,
which on an open mesh (a grid, a plane) deleted the ring's vertices out from
under the face about to be built from them, leaving edges pointing at dead
vertices. The rebuilt face is added before loose vertices are swept, so the ring
is never briefly orphaned.

### Normals — `normals.ts`

`recalculateNormals` is two stages, and both matter:

1. Breadth-first across each connected shell, flipping any neighbour that
   traverses a shared edge in the *same* direction as its neighbour — two
   consistently wound faces always traverse it oppositely.
2. Compute the shell's signed volume and flip the whole shell if it is inside
   out. Consistency alone still permits a uniformly inverted shell, which is
   exactly the case that ruins an export.

### Fill and bridge — `fill.ts`

`edgeLoopsFrom` chains selected edges into ordered rings; both fill and bridge
build on it. Fills are wound against the surrounding surface so their normals
agree with it. Bridge aligns the second loop by testing every rotation and both
directions, picking the one with the least total distance — without that, bridging
two rings built in opposite directions folds the band over itself.

### Selection walks — `select.ts`

`selectEdgeLoop` continues through a valence-4 vertex along the one edge sharing
no face with the current edge. Any other valence ends the loop, which is why
Alt+click stops at poles — and why the loop on an open tube's rim is a single
edge.

## Modifiers

`evaluateModifiers` clones the base mesh once and pipes it through each enabled
modifier. The object being edited is never touched, which is what makes the stack
non-destructive. `applyModifier` bakes a single one into the mesh.

Mirror reflects and reverses winding (reflection inverts handedness), optionally
welding the seam. Solidify offsets a shell along vertex normals, reverses it, and
fills rim quads along boundary edges captured *before* the shell was added.
