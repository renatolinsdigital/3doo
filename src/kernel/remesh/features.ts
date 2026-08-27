import { type Vec3, dot, normalize, sub, vec3 } from '../math';
import type { BMesh } from '../mesh';

/** A crease of the source surface, as the straight run between two vertices. */
export interface FeatureSegment {
  a: Vec3;
  b: Vec3;
}

export interface FeatureSet {
  segments: FeatureSegment[];
  /** Points where creases meet or turn: the shape's hard corners. */
  corners: Vec3[];
}

/**
 * The creases and corners of a surface, above a dihedral angle.
 *
 * A voxel remesh samples the model onto a grid, and a grid has no way to hold
 * an edge that does not run along it: the result of a cube comes back with its
 * twelve edges chamfered into staircases. Feeding these back in as constraints
 * is what turns that into a cube again, and it is the difference between a
 * remesher that only suits organic shapes and one that can be pointed at
 * anything.
 *
 * Open borders and non-manifold seams count as creases too — they are edges of
 * the surface, whatever angle they sit at.
 */
export function detectFeatures(mesh: BMesh, angleDegrees: number): FeatureSet {
  if (angleDegrees <= 0) return { segments: [], corners: [] };

  const limit = Math.cos((Math.min(angleDegrees, 180) * Math.PI) / 180);
  const segments: FeatureSegment[] = [];
  /** Directions the creases leave each vertex along, for the corner test. */
  const spokes = new Map<number, Vec3[]>();

  for (const edge of mesh.edges.values()) {
    const faces = mesh.edgeFaces(edge);
    // A wire edge is not a crease in a surface: the sampler never saw it.
    if (faces.length === 0) continue;

    const crease =
      edge.sharp || faces.length !== 2 || dot(faces[0].normal, faces[1].normal) < limit;
    if (!crease) continue;

    segments.push({ a: edge.v0.co, b: edge.v1.co });
    for (const [vert, other] of [
      [edge.v0, edge.v1],
      [edge.v1, edge.v0],
    ]) {
      const list = spokes.get(vert.id) ?? [];
      list.push(normalize(sub(other.co, vert.co)));
      spokes.set(vert.id, list);
    }
  }

  const corners: Vec3[] = [];
  const claimed = new Set<number>();
  for (const [vertId, directions] of spokes) {
    const vert = mesh.verts.get(vertId);
    if (!vert) continue;

    // Three creases meeting is a corner however they are angled; one is the end
    // of a crease, which is a corner too. Two carry on through, and only turn
    // it into a corner if the line itself bends by more than the threshold —
    // that is what lets the rim of a cylinder stay a smooth ring its vertices
    // can slide around, rather than a ring of pins.
    if (directions.length !== 2) {
      corners.push(vert.co);
      claimed.add(vertId);
      continue;
    }
    if (-dot(directions[0], directions[1]) < limit) {
      corners.push(vert.co);
      claimed.add(vertId);
    }
  }

  for (const vert of spikes(mesh, angleDegrees)) {
    if (!claimed.has(vert.id)) corners.push(vert.co);
  }

  return { segments, corners };
}

/**
 * Points the surface comes to, which no pair of faces is creased across.
 *
 * The tip of a cone is the plain case: every edge running down from it turns by
 * a couple of degrees, so nothing there is a crease and the crease rule above
 * never looks at the vertex — and yet it is the sharpest thing on the model and
 * the first thing anyone notices missing when a remesh flattens it off.
 *
 * What gives it away is the angle deficit: how far the faces around a vertex
 * fall short of covering the full turn, which is the discrete form of Gaussian
 * curvature. It is nothing on a flat wall, a fraction of a radian on the coarse
 * vertex of a low-poly sphere, and most of a full turn at a spike — a gap wide
 * enough that the line between them is not a delicate one.
 */
function* spikes(mesh: BMesh, angleDegrees: number): Generator<{ id: number; co: Vec3 }> {
  // Scaled off the same control as the creases, and set so a cone tip is caught
  // while the twelve original corners of a subdivided icosphere are not — those
  // are how a sphere is tessellated, not how it is shaped.
  const threshold = (Math.PI * 2 * Math.min(angleDegrees, 90)) / 90;

  const open = new Set<number>();
  for (const edge of mesh.edges.values()) {
    if (edge.loops.length === 2) continue;
    open.add(edge.v0.id);
    open.add(edge.v1.id);
  }

  const covered = new Map<number, number>();
  for (const face of mesh.faces.values()) {
    const ring = mesh.faceVerts(face);
    if (ring.length < 3) continue;
    for (let i = 0; i < ring.length; i++) {
      const at = ring[i];
      if (open.has(at.id)) continue;
      const before = normalize(sub(ring[(i - 1 + ring.length) % ring.length].co, at.co));
      const after = normalize(sub(ring[(i + 1) % ring.length].co, at.co));
      const cosine = Math.min(1, Math.max(-1, dot(before, after)));
      covered.set(at.id, (covered.get(at.id) ?? 0) + Math.acos(cosine));
    }
  }

  for (const [id, turn] of covered) {
    if (Math.PI * 2 - turn <= threshold) continue;
    const vert = mesh.verts.get(id);
    // A vertex the border touches has a deficit for the dull reason that there
    // is no surface on one side of it, which says nothing about its shape.
    if (vert && !open.has(id)) yield { id, co: vert.co };
  }
}

interface SegmentHit {
  point: Vec3;
  distance: number;
}

export interface CornerHit {
  point: Vec3;
  distance: number;
  /** Which corner was hit, so one output vertex can be chosen per corner. */
  index: number;
}

const HASH_X = 73856093;
const HASH_Y = 19349663;
const HASH_Z = 83492791;

/**
 * Spatial hash over the creases, for the snapping the relaxation does per pass.
 *
 * Hashed rather than a dense grid: features occupy a thin shell of the model's
 * bounding box, and allocating a cell for every voxel of it would cost more
 * memory than the distance field itself.
 */
export class FeatureIndex {
  readonly corners: readonly Vec3[];

  private readonly segments: readonly FeatureSegment[];
  private readonly segmentCells = new Map<number, number[]>();
  private readonly cornerCells = new Map<number, number[]>();
  private readonly cell: number;

  constructor(features: FeatureSet, cell: number) {
    this.segments = features.segments;
    this.corners = features.corners;
    this.cell = Math.max(cell, 1e-6);

    for (let i = 0; i < features.segments.length; i++) {
      const { a, b } = features.segments[i];
      const lo = this.cellOf({
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        z: Math.min(a.z, b.z),
      });
      const hi = this.cellOf({
        x: Math.max(a.x, b.x),
        y: Math.max(a.y, b.y),
        z: Math.max(a.z, b.z),
      });

      for (let x = lo.x; x <= hi.x; x++) {
        for (let y = lo.y; y <= hi.y; y++) {
          for (let z = lo.z; z <= hi.z; z++) {
            const key = hash(x, y, z);
            const bucket = this.segmentCells.get(key);
            if (bucket) bucket.push(i);
            else this.segmentCells.set(key, [i]);
          }
        }
      }
    }

    for (let i = 0; i < features.corners.length; i++) {
      const { x, y, z } = this.cellOf(features.corners[i]);
      const key = hash(x, y, z);
      const bucket = this.cornerCells.get(key);
      if (bucket) bucket.push(i);
      else this.cornerCells.set(key, [i]);
    }
  }

  get empty(): boolean {
    return this.segments.length === 0 && this.corners.length === 0;
  }

  nearestCorner(point: Vec3, radius: number): CornerHit | null {
    let best: CornerHit | null = null;

    for (const index of this.candidates(this.cornerCells, point, radius)) {
      const corner = this.corners[index];
      const distance = Math.sqrt(distanceSquared(point, corner));
      if (distance > radius) continue;
      if (best && distance >= best.distance) continue;
      best = { point: corner, distance, index };
    }

    return best;
  }

  /** The crease segment nearest a point, for the direction it runs in. */
  nearestSegment(point: Vec3, radius: number): FeatureSegment | null {
    let best: FeatureSegment | null = null;
    let bestDistance = radius;

    for (const index of this.candidates(this.segmentCells, point, radius)) {
      const segment = this.segments[index];
      const hit = closestOnSegment(point, segment);
      if (hit.distance > bestDistance) continue;
      bestDistance = hit.distance;
      best = segment;
    }

    return best;
  }

  nearestOnSegment(point: Vec3, radius: number): SegmentHit | null {
    let best: SegmentHit | null = null;

    for (const index of this.candidates(this.segmentCells, point, radius)) {
      const hit = closestOnSegment(point, this.segments[index]);
      if (hit.distance > radius) continue;
      if (best && hit.distance >= best.distance) continue;
      best = hit;
    }

    return best;
  }

  /** Every entry in the cells a sphere of `radius` touches, without duplicates. */
  private *candidates(
    cells: Map<number, number[]>,
    point: Vec3,
    radius: number,
  ): Generator<number> {
    if (cells.size === 0) return;

    const reach = Math.max(1, Math.ceil(radius / this.cell));
    const base = this.cellOf(point);
    const seen = new Set<number>();

    for (let x = base.x - reach; x <= base.x + reach; x++) {
      for (let y = base.y - reach; y <= base.y + reach; y++) {
        for (let z = base.z - reach; z <= base.z + reach; z++) {
          const bucket = cells.get(hash(x, y, z));
          if (!bucket) continue;
          for (const index of bucket) {
            if (seen.has(index)) continue;
            seen.add(index);
            yield index;
          }
        }
      }
    }
  }

  private cellOf(point: Vec3): { x: number; y: number; z: number } {
    return {
      x: Math.floor(point.x / this.cell),
      y: Math.floor(point.y / this.cell),
      z: Math.floor(point.z / this.cell),
    };
  }
}

function hash(x: number, y: number, z: number): number {
  return ((x * HASH_X) ^ (y * HASH_Y) ^ (z * HASH_Z)) >>> 0;
}

function distanceSquared(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function closestOnSegment(point: Vec3, segment: FeatureSegment): SegmentHit {
  const along = sub(segment.b, segment.a);
  const lengthSq = along.x * along.x + along.y * along.y + along.z * along.z;
  if (lengthSq < 1e-18) {
    return { point: segment.a, distance: Math.sqrt(distanceSquared(point, segment.a)) };
  }

  const t = Math.min(1, Math.max(0, dot(sub(point, segment.a), along) / lengthSq));
  const hit = vec3(segment.a.x + along.x * t, segment.a.y + along.y * t, segment.a.z + along.z * t);
  return { point: hit, distance: Math.sqrt(distanceSquared(point, hit)) };
}
