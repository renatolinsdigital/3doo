import { type Axis, type Vec3, axisVector, cross, dot, lerp } from '../math';
import { type BMesh, cloneMesh, splitFaces } from '../mesh';
import type { Vert } from '../mesh/types';

import { type KnifeCutResult, type KnifePoint, knifeCut } from './knife';

/**
 * How near the plane a vertex may lie, as a fraction of the mesh's depth
 * across it, and still be taken as lying on it.
 *
 * The middle of a symmetric mesh lands on its middle loop give or take the
 * last bit of a float, and cutting the edges round that loop a hair from
 * their ends would leave slivers nobody can see or pick.
 */
const ON_PLANE = 1e-6;

/** A point where the plane meets a face's border. */
interface Meeting {
  point: KnifePoint;
  co: Vec3;
  /** False where the border only touches the plane at a corner and carries on along the same side. */
  crosses: boolean;
}

/**
 * Cuts every face the plane crosses along it, so each face afterwards lies
 * wholly on one side. The plane holds the points whose `dot` with `normal` is
 * `offset`.
 *
 * Each face is sliced on its own and the pieces go to the knife, which already
 * carries UVs, smoothing, materials and sharp edges across a cut. A corner on
 * the plane counts as lying on its positive side, which keeps the crossings
 * round every border in pairs: an edge running from the plane to the negative
 * side is crossed at its end, one running to the positive side is not. Across
 * a face that bends back on itself the crossings are paired in order along the
 * plane, and a corner the plane only touches on the way divides the piece
 * running through it, so neither side is left pinched at that corner.
 */
export function bisectMesh(mesh: BMesh, normal: Vec3, offset: number): KnifeCutResult {
  const heights = new Map<number, number>();
  let low = Infinity;
  let high = -Infinity;
  for (const vert of mesh.verts.values()) {
    const height = dot(vert.co, normal) - offset;
    heights.set(vert.id, height);
    low = Math.min(low, height);
    high = Math.max(high, height);
  }
  const tolerance = ON_PLANE * (high - low);
  const side = (vert: Vert): number => {
    const height = heights.get(vert.id) ?? 0;
    return Math.abs(height) <= tolerance ? 0 : height;
  };
  const atVert = (vert: Vert, crosses: boolean): Meeting => ({
    point: { kind: 'vert', vert: vert.id },
    co: vert.co,
    crosses,
  });

  const runs: KnifePoint[][] = [];
  for (const face of mesh.faces.values()) {
    const meetings: Meeting[] = [];
    const crossed = new Set<Vert>();
    const loops = mesh.faceLoops(face);

    for (const loop of loops) {
      const here = side(loop.vert);
      const there = side(loop.next.vert);
      if (here >= 0 === there >= 0) continue;

      if (here === 0 || there === 0) {
        const vert = here === 0 ? loop.vert : loop.next.vert;
        crossed.add(vert);
        meetings.push(atVert(vert, true));
        continue;
      }
      const t = here / (here - there);
      meetings.push({
        point: { kind: 'edge', edge: loop.edge.id, t: loop.edge.v0 === loop.vert ? t : 1 - t },
        co: lerp(loop.vert.co, loop.next.vert.co, t),
        crosses: true,
      });
    }
    if (meetings.length < 2) continue;

    for (const loop of loops) {
      if (side(loop.vert) === 0 && !crossed.has(loop.vert)) meetings.push(atVert(loop.vert, false));
    }
    const across = cross(normal, face.normal);
    meetings.sort((first, second) => dot(first.co, across) - dot(second.co, across));

    let start: Meeting | null = null;
    for (const meeting of meetings) {
      if (meeting.crosses) {
        if (start) runs.push([start.point, meeting.point]);
        start = start ? null : meeting;
      } else if (start) {
        runs.push([start.point, meeting.point]);
        start = meeting;
      }
    }
  }

  return knifeCut(
    mesh,
    runs.filter(
      ([from, to]) => !(from.kind === 'vert' && to.kind === 'vert' && from.vert === to.vert),
    ),
  );
}

/**
 * Cuts a mesh in two across one of its own axes, halfway between the ends of
 * its bounds: the half on the negative side first, the positive one second.
 * Null when there is nothing on one side to cut off, as across a flat plane.
 *
 * Every face the middle runs through is split along it, and nothing is closed
 * over: a solid comes apart into two open shells, its inside showing where it
 * was cut. The mesh handed in is left as it was, so another object sharing it
 * keeps its shape.
 */
export function cutMeshInHalf(mesh: BMesh, axis: Axis): [negative: BMesh, positive: BMesh] | null {
  const { min, max } = mesh.boundingBox();
  const depth = max[axis] - min[axis];
  if (!(depth > 0)) return null;

  const middle = (min[axis] + max[axis]) / 2;
  const work = cloneMesh(mesh);
  bisectMesh(work, axisVector(axis), middle);

  // Every face now lies on one side, so the average of its corners does too.
  const halves = splitFaces(work, (face) => {
    const corners = work.faceVerts(face);
    const sum = corners.reduce((total, vert) => total + vert.co[axis] - middle, 0);
    return sum / corners.length > ON_PLANE * depth;
  });
  return halves[0].faces.size > 0 && halves[1].faces.size > 0 ? halves : null;
}
