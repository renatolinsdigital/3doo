import { type Vec3, clamp, clone, dot, lerp, normalize, sub } from '../math';
import type { BMesh } from '../mesh';
import type { Edge, Face, Vert } from '../mesh/types';

/**
 * Where one vertex may travel during a slide, and how far.
 *
 * Both ends are points the mesh already holds: the far end of an edge running
 * out of the vertex. That is the whole of what makes a slide a slide rather
 * than a move. The vertex stays on geometry that was already there, and at
 * either extreme it lands exactly on a neighbour of its own.
 */
export interface SlideRail {
  vert: Vert;
  /** Where the vertex sat when the slide was planned. Factor 0 puts it back. */
  origin: Vec3;
  /** Where it lands at factor +1, or `origin` again where that way is closed. */
  positive: Vec3;
  /** Where it lands at factor -1, or `origin` again where that way is closed. */
  negative: Vec3;
}

export interface SlidePlan {
  kind: 'vertex' | 'edge';
  rails: SlideRail[];
}

/**
 * Plans a slide of loose vertices along the edges leaving them.
 *
 * `hint` is which way the pointer is asking to go, in object space: the edge
 * pointing most nearly along it becomes the positive way out and the one
 * pointing most nearly against it the negative, which is what lets the vertex
 * under the cursor slide down the edge the cursor is reaching along. Without a
 * hint the straightest pair of edges through the vertex is taken instead.
 */
export function planVertexSlide(
  mesh: BMesh,
  verts: readonly Vert[],
  hint: Vec3 | null = null,
): SlidePlan {
  const rails: SlideRail[] = [];

  for (const vert of verts) {
    if (!mesh.verts.has(vert.id)) continue;

    const neighbours = vert.edges.map((edge) => mesh.edgeOther(edge, vert));
    if (neighbours.length === 0) continue;

    const origin = clone(vert.co);
    if (neighbours.length === 1) {
      rails.push({ vert, origin, positive: clone(neighbours[0].co), negative: clone(origin) });
      continue;
    }

    const directions = neighbours.map((neighbour) => normalize(sub(neighbour.co, origin)));
    let positive = 0;
    let negative = 1;

    if (hint) {
      const along = normalize(hint);
      let nearest = -Infinity;
      let furthest = Infinity;

      directions.forEach((direction, i) => {
        const towards = dot(direction, along);
        if (towards > nearest) {
          nearest = towards;
          positive = i;
        }
        if (towards < furthest) {
          furthest = towards;
          negative = i;
        }
      });
    } else {
      // The straightest pair: the two edges facing most nearly opposite ways.
      // Sliding along those reads as travel down one line through the vertex
      // rather than as a turn at it.
      let opposed = Infinity;
      for (let i = 0; i < directions.length; i++) {
        for (let j = i + 1; j < directions.length; j++) {
          const facing = dot(directions[i], directions[j]);
          if (facing < opposed) {
            opposed = facing;
            positive = i;
            negative = j;
          }
        }
      }
    }

    // Every direction read the same, which only happens on degenerate geometry.
    // Any second edge beats sliding both ways down the first one.
    if (negative === positive) negative = (positive + 1) % neighbours.length;

    rails.push({
      vert,
      origin,
      positive: clone(neighbours[positive].co),
      negative: clone(neighbours[negative].co),
    });
  }

  return { kind: 'vertex', rails };
}

/**
 * The other edge of `face` that touches `vert`.
 *
 * Two of a face's edges meet at any vertex of it: the one arriving and the one
 * leaving. Where one of them is the edge being slid, the other is the rail that
 * vertex travels along on this side of it.
 */
function railInFace(mesh: BMesh, face: Face, edge: Edge, vert: Vert): Edge | null {
  const at = mesh.faceLoops(face).find((loop) => loop.vert === vert);
  if (!at) return null;
  if (at.edge === edge) return at.prev.edge;
  if (at.prev.edge === edge) return at.edge;
  return null;
}

/**
 * Plans a slide of selected edges across the faces to either side of them.
 *
 * Each vertex of the selection travels along a rail: the edge running out of it
 * across the face on one side, and the one across the face on the other. At
 * either extreme the whole loop lands exactly on the loop next door, which is
 * what auto merge is there to collapse.
 *
 * Which side counts as positive is settled once and then carried across the
 * whole selection, so a loop slides as one piece instead of every vertex
 * picking a side of its own. Two loop edges meeting at a vertex are on the same
 * side exactly when their faces there run out along the same rail, and
 * spreading that agreement from edge to edge is what the walk below does.
 */
export function planEdgeSlide(mesh: BMesh, edges: readonly Edge[]): SlidePlan {
  const live = edges.filter((edge) => mesh.edges.has(edge.id) && edge.loops.length > 0);
  const selected = new Set(live.map((edge) => edge.id));
  const positiveFace = new Map<number, Face>();

  for (const seed of live) {
    if (positiveFace.has(seed.id)) continue;

    positiveFace.set(seed.id, mesh.edgeFaces(seed)[0]);
    const pending: Edge[] = [seed];

    while (pending.length > 0) {
      const edge = pending.pop() as Edge;
      const face = positiveFace.get(edge.id) as Face;

      for (const vert of [edge.v0, edge.v1]) {
        const rail = railInFace(mesh, face, edge, vert);
        if (!rail) continue;

        for (const next of vert.edges) {
          if (next === edge || !selected.has(next.id) || positiveFace.has(next.id)) continue;

          const side = mesh
            .edgeFaces(next)
            .find((candidate) => railInFace(mesh, candidate, next, vert) === rail);
          if (!side) continue;

          positiveFace.set(next.id, side);
          pending.push(next);
        }
      }
    }
  }

  // One rail per vertex, from whichever of the selected edges at it is reached
  // first: in a manifold selection both of them name the same pair.
  const rails = new Map<number, SlideRail>();

  for (const edge of live) {
    const face = positiveFace.get(edge.id);
    if (!face) continue;
    const opposite = mesh.edgeFaces(edge).find((candidate) => candidate !== face) ?? null;

    for (const vert of [edge.v0, edge.v1]) {
      if (rails.has(vert.id)) continue;

      const forward = railInFace(mesh, face, edge, vert);
      const back = opposite ? railInFace(mesh, opposite, edge, vert) : null;
      if (!forward && !back) continue;

      const origin = clone(vert.co);
      rails.set(vert.id, {
        vert,
        origin,
        // A boundary edge has nothing on its far side, so that way is closed
        // and the vertex holds still when the slide runs against it.
        positive: forward ? clone(mesh.edgeOther(forward, vert).co) : clone(origin),
        negative: back ? clone(mesh.edgeOther(back, vert).co) : clone(origin),
      });
    }
  }

  return { kind: 'edge', rails: [...rails.values()] };
}

/**
 * Moves every planned vertex to `factor` along its rail, +1 to -1.
 *
 * Always measured from where the slide started rather than from wherever the
 * last call left things, so a drag can run back and forth over the same ground
 * without accumulating, and factor 0 is exactly the mesh the slide began with.
 */
export function applySlide(mesh: BMesh, plan: SlidePlan, factor: number): void {
  const travel = clamp(factor, -1, 1);

  for (const rail of plan.rails) {
    if (!mesh.verts.has(rail.vert.id)) continue;
    rail.vert.co = lerp(rail.origin, travel >= 0 ? rail.positive : rail.negative, Math.abs(travel));
  }

  mesh.computeNormals();
}
