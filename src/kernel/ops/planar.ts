import { type Vec3, cross, degToRad, dot, length, lengthSq, sub, vec3 } from '../math';
import type { BMesh } from '../mesh';
import type { Face, Vert } from '../mesh/types';

/**
 * How far a quad may bend before it counts as not planar, in degrees.
 *
 * Measured as the crease along its flatter diagonal (see `quadBend`). A tenth
 * of a degree is well before a bend shows in the shading, and above the
 * rounding a planar quad a centimetre across or more picks up when a file
 * stores it to six decimal places.
 */
export const PLANAR_TOLERANCE_DEGREES = 0.1;

const PLANAR_TOLERANCE = degToRad(PLANAR_TOLERANCE_DEGREES);

/**
 * Below this, as height over base, a triangle is a line and has no plane to
 * fold: its normal would be rounding pointing anywhere.
 */
const SLIVER = 1e-9;

/**
 * The crease along the diagonal from `a` to `c`: the angle between the
 * triangles either side of it, `a b c` and `a c d`.
 */
function fold(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const diagonal = sub(c, a);
  const first = cross(sub(b, a), diagonal);
  const second = cross(diagonal, sub(d, a));

  const base = lengthSq(diagonal);
  const sliver = SLIVER * SLIVER * base * base;
  if (lengthSq(first) <= sliver || lengthSq(second) <= sliver) return 0;

  return Math.atan2(length(cross(first, second)), dot(first, second));
}

/**
 * How far a quad bends out of flat, in radians: 0 for a planar one.
 *
 * A quad is drawn as two triangles, and the bend is the crease between them.
 * Either diagonal can carry it, so this is the crease along the flatter of the
 * two. The other one is not a bend at all on a concave quad: it runs outside
 * the face, and its triangles overlap facing opposite ways.
 */
export function quadBend(corners: readonly Vec3[]): number {
  const [a, b, c, d] = corners;
  return Math.min(fold(a, b, c, d), fold(b, c, d, a));
}

/** Whether a quad bends past `PLANAR_TOLERANCE_DEGREES`. */
export function isNonPlanarQuad(corners: readonly Vec3[]): boolean {
  return quadBend(corners) > PLANAR_TOLERANCE;
}

/**
 * The gap flattening stops at, over the size of the quad: past what a 32-bit
 * float, which the GPU and most export formats hold, can tell from flat.
 */
const FLAT = 1e-7;

/**
 * How many times flattening re-solves before it gives up.
 *
 * Each solve settles every quad at once, and is out only by how far the quads
 * tilt as their corners move, so a few are usually enough. A patch that cannot
 * be flat everywhere at once stops here, and the caller hears how many quads
 * are still bent.
 */
const MAX_SOLVES = 32;

/** How many steps a solve takes towards its answer, at the most. */
const MAX_STEPS = 2000;

/**
 * How much solving one call may do, counted as quads times steps: about a
 * second's work.
 *
 * Every quad's bend has to reach every other quad it shares a corner with,
 * however far apart, so a large patch bent every which way takes many steps to
 * settle. Past this the call stops part of the way there and says how many are
 * still bent, and another call carries on from where it left them.
 */
const WORK_BUDGET = 2e7;

/**
 * Added to every quad's own entry in the solve, so quads whose constraints
 * repeat one another cannot leave it dividing by nothing. Every entry is 1 or
 * less (see `twists`), so this changes no answer measurably.
 */
const DAMPING = 1e-12;

/**
 * How many times a step that made things worse is halved and tried again.
 *
 * A solve takes each quad's normal as fixed, and a corner moving far enough to
 * tilt the quad leaves it short or past. Halving finds a step that still
 * helps, rather than one that carries a corner across a quad and turns it
 * inside out.
 */
const MAX_HALVINGS = 12;

/**
 * The quads to flatten, flattened into arrays: each vertex's place once, and
 * each quad as the four slots of its corners.
 */
interface QuadSystem {
  positions: Float64Array;
  corners: Int32Array;
  /** Per quad, which way each corner moves to close its gap: twelve numbers, length 1. */
  rows: Float64Array;
  /** Per quad, how far along its row the corners have to move. */
  offsets: Float64Array;
  /** Per quad, the cross of its diagonals: which way it faces, to see it turn over. */
  facing: Float64Array;
}

/** How bent the quads are, as `twists` measures them. */
interface Twist {
  /** The largest gap relative to its quad's size. */
  worst: number;
  /** The offsets squared and summed: what each step has to bring down. */
  total: number;
}

function corner(system: QuadSystem, quad: number, k: number): Vec3 {
  const at = system.corners[quad * 4 + k] * 3;
  const { positions } = system;
  return vec3(positions[at], positions[at + 1], positions[at + 2]);
}

/**
 * Writes each quad's row, offset and facing into the system, and says how bent
 * the quads are.
 *
 * A flat quad's diagonals cross. A bent one's pass each other with a gap,
 * measured along the line square to both, which is the quad's normal. The gap
 * closes when the first and third corners move one way along the normal and
 * the second and fourth the other, by half of it each: that is the row, and
 * all a quad on its own ever has to move.
 */
function twists(system: QuadSystem): Twist {
  const { rows, offsets, facing } = system;
  let worst = 0;
  let total = 0;

  for (let quad = 0; quad < offsets.length; quad++) {
    const a = corner(system, quad, 0);
    const b = corner(system, quad, 1);
    const normal = cross(sub(corner(system, quad, 2), a), sub(corner(system, quad, 3), b));
    facing.set([normal.x, normal.y, normal.z], quad * 3);

    const row = rows.subarray(quad * 12, quad * 12 + 12);
    const size = length(normal);
    // Parallel diagonals: the quad has folded into a line or crossed itself,
    // and has no normal to flatten along. It is left where it is.
    if (size === 0) {
      row.fill(0);
      offsets[quad] = 0;
      continue;
    }

    const x = normal.x / size;
    const y = normal.y / size;
    const z = normal.z / size;
    for (let k = 0; k < 4; k++) {
      const way = k % 2 === 0 ? 0.5 : -0.5;
      row[k * 3] = x * way;
      row[k * 3 + 1] = y * way;
      row[k * 3 + 2] = z * way;
    }

    const gap = x * (b.x - a.x) + y * (b.y - a.y) + z * (b.z - a.z);
    offsets[quad] = gap;
    total += gap * gap;
    // The cross of the diagonals is twice the quad's area, so its root is the
    // quad's size, and this is the same at any scale.
    worst = Math.max(worst, Math.abs(gap) / Math.sqrt(size));
  }

  return { worst, total };
}

/** Whether any quad faces against the way it faced in `before`. */
function turnedOver(system: QuadSystem, before: Float64Array): boolean {
  const { facing } = system;
  for (let at = 0; at < facing.length; at += 3) {
    const along =
      facing[at] * before[at] + facing[at + 1] * before[at + 1] + facing[at + 2] * before[at + 2];
    if (along < 0) return true;
  }
  return false;
}

/** Each corner's movement, from how far each quad's row is followed. */
function spread(system: QuadSystem, weights: Float64Array, out: Float64Array): void {
  const { corners, rows } = system;
  out.fill(0);
  for (let quad = 0; quad < weights.length; quad++) {
    const weight = weights[quad];
    for (let k = 0; k < 4; k++) {
      const at = corners[quad * 4 + k] * 3;
      const from = quad * 12 + k * 3;
      out[at] += rows[from] * weight;
      out[at + 1] += rows[from + 1] * weight;
      out[at + 2] += rows[from + 2] * weight;
    }
  }
}

/** How far a movement of the corners carries each quad along its row. */
function gather(system: QuadSystem, movement: Float64Array, out: Float64Array): void {
  const { corners, rows } = system;
  for (let quad = 0; quad < out.length; quad++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const at = corners[quad * 4 + k] * 3;
      const from = quad * 12 + k * 3;
      sum +=
        rows[from] * movement[at] +
        rows[from + 1] * movement[at + 1] +
        rows[from + 2] * movement[at + 2];
    }
    out[quad] = sum;
  }
}

function dotAll(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * The smallest movement of the corners that closes every quad's gap at once,
 * with each quad's normal held where it is, written into `movement`.
 *
 * The movement is a sum of the quads' rows, one weight each, and the weights
 * come out of a system with one equation a quad, solved by conjugate
 * gradients without the matrix ever being built: applying it is `spread` and
 * then `gather`. A quad with no neighbour in the set needs one step.
 *
 * Returns how many steps it took, at most `maxSteps`.
 */
function solve(system: QuadSystem, movement: Float64Array, maxSteps: number): number {
  const count = system.offsets.length;
  const weights = new Float64Array(count);
  const residual = Float64Array.from(system.offsets);
  const direction = Float64Array.from(residual);
  const applied = new Float64Array(count);

  // A thousandth of the way short is near enough. Holding the normals still
  // already throws the answer off by more, and the next solve takes up both.
  let error = dotAll(residual, residual);
  const enough = error * 1e-6;

  let step = 0;
  for (; step < maxSteps && error > enough; step++) {
    spread(system, direction, movement);
    gather(system, movement, applied);
    for (let i = 0; i < count; i++) applied[i] += DAMPING * direction[i];

    const curve = dotAll(direction, applied);
    if (curve <= 0) break;
    const along = error / curve;
    for (let i = 0; i < count; i++) {
      weights[i] += along * direction[i];
      residual[i] -= along * applied[i];
    }

    const next = dotAll(residual, residual);
    const keep = next / error;
    error = next;
    for (let i = 0; i < count; i++) direction[i] = residual[i] + keep * direction[i];
  }

  spread(system, weights, movement);
  return step;
}

export interface PlanarResult {
  /** Quads among the faces handed in; anything else is left alone. */
  quads: number;
  /** Quads that bent past the tolerance before. */
  bentBefore: number;
  /** Quads still bent past it, pulled out of flat by the quads around them. */
  bentAfter: number;
  /** Whether any vertex moved. */
  moved: boolean;
}

/**
 * Flattens the quads among `faces`, moving their corners as little as it can.
 *
 * Every quad is settled at once rather than one after another: flattening one
 * quad on its own moves corners its neighbours share, and walking that out
 * across a patch of them takes thousands of passes. Instead each solve finds
 * the smallest movement of every corner that flattens every quad together, and
 * a few repeats take out what tilting the quads on the way throws off.
 *
 * Vertices are shared with faces outside the selection too, so flattening a
 * quad can bend a neighbour that was not selected.
 *
 * Triangles are always flat, and an n-gon has no one plane to project on that
 * leaves it the shape it was, so both are skipped.
 */
export function makeQuadsPlanar(mesh: BMesh, faces: readonly Face[]): PlanarResult {
  const verts: Vert[] = [];
  const slots = new Map<Vert, number>();
  const ring: number[] = [];
  for (const face of faces) {
    if (mesh.faceLoopCount(face) !== 4) continue;
    for (const vert of mesh.faceVerts(face)) {
      let slot = slots.get(vert);
      if (slot === undefined) {
        slot = verts.length;
        slots.set(vert, slot);
        verts.push(vert);
      }
      ring.push(slot);
    }
  }

  const quads = ring.length / 4;
  const system: QuadSystem = {
    positions: new Float64Array(verts.length * 3),
    corners: Int32Array.from(ring),
    rows: new Float64Array(quads * 12),
    offsets: new Float64Array(quads),
    facing: new Float64Array(quads * 3),
  };
  const { positions } = system;
  verts.forEach((vert, slot) => positions.set([vert.co.x, vert.co.y, vert.co.z], slot * 3));

  const countBent = () => {
    let bent = 0;
    for (let quad = 0; quad < quads; quad++) {
      if (isNonPlanarQuad([0, 1, 2, 3].map((k) => corner(system, quad, k)))) bent++;
    }
    return bent;
  };
  const bentBefore = countBent();

  const movement = new Float64Array(positions.length);
  const start = new Float64Array(positions.length);
  const facing = new Float64Array(system.facing.length);
  let moved = false;
  let twist = twists(system);
  let work = WORK_BUDGET;

  for (let round = 0; round < MAX_SOLVES && twist.worst > FLAT; round++) {
    const maxSteps = Math.min(MAX_STEPS, Math.floor(work / quads));
    if (maxSteps === 0) break;
    work -= solve(system, movement, maxSteps) * quads;
    start.set(positions);
    facing.set(system.facing);

    // The full step first, then half of it, and so on, until one leaves the
    // gaps smaller than they were with no quad turned over.
    let reach = 1;
    let next: Twist | null = null;
    for (let halving = 0; halving <= MAX_HALVINGS; halving++, reach /= 2) {
      for (let i = 0; i < positions.length; i++) positions[i] = start[i] + reach * movement[i];
      const trial = twists(system);
      if (trial.total < twist.total && !turnedOver(system, facing)) {
        next = trial;
        break;
      }
    }

    // Nothing along the way helped: this is as flat as the quads will go.
    if (!next) {
      positions.set(start);
      break;
    }
    twist = next;
    moved = true;
  }

  if (moved) {
    verts.forEach((vert, slot) => {
      const at = slot * 3;
      vert.co = vec3(positions[at], positions[at + 1], positions[at + 2]);
    });
    mesh.computeNormals();
  }

  return { quads, bentBefore, bentAfter: countBent(), moved };
}
