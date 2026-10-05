import {
  type BMesh,
  type FalloffCurve,
  type ProportionalInfluence,
  type ProportionalOptions,
  type Vec3,
  type Vert,
  proportionalInfluence,
  radToDeg,
  rotateVerts,
  scaleVerts,
  translateVerts,
} from '@kernel/index';

/** The whole of what an edit-mode transform does, measured from where it began. */
export type EditMove =
  | { kind: 'translate'; offset: Vec3 }
  | { kind: 'rotate'; axis: Vec3; angle: number; pivot: Vec3 }
  | { kind: 'scale'; factor: Vec3; pivot: Vec3 };

/** The operation that repeats a transform, in the parameters the kernel's operator reads. */
export interface EditMoveCall {
  name: 'translate' | 'rotate' | 'scale';
  params: Record<string, unknown>;
}

/** Below this a move is taken as none at all: no offset, no turn, a factor of one. */
const NOTHING = 1e-12;

/**
 * An edit-mode transform from its first step to its last.
 *
 * Every step puts back what the last one moved and applies the whole move
 * again, rather than adding the step since the last pointer move on top. That
 * is what makes the result one move: the same as running `translate`, `rotate`
 * or `scale` once on the mesh as it stood, with the settings the drag ended
 * on, which is what lets the ACTIONS log write it as one call. Steps stacked
 * on top would not add up to one: a proportional scale multiplies the falloff
 * into every step, and a radius changed mid-drag would only reach what came
 * after it.
 */
export class EditMoveDrag {
  /** Where each vertex any step has moved stood when the transform began. */
  private readonly origins = new Map<Vert, Vec3>();
  private moved: readonly Vert[] = [];
  /**
   * The vertices proportional editing carries, measured once from where the
   * selection began, and again only when the radius or the curve changes.
   * Measuring it means testing every vertex against every selected one, the
   * slowest thing a step can do, and measuring from where the selection has
   * moved to would let the circle of influence crawl along with it.
   */
  private spread: {
    radius: number;
    falloff: FalloffCurve;
    influence: ProportionalInfluence;
  } | null = null;
  private proportional: ProportionalOptions | null = null;
  private key = '';
  move: EditMove | null = null;

  constructor(
    readonly mesh: BMesh,
    /** What a turn or a scale is measured about, in the object's own space. */
    readonly pivot: Vec3,
  ) {}

  /**
   * Puts the vertices where `move` takes them from where they began. False
   * when that is where the last step left them: snapping holds a drag on one
   * notch for many pointer moves, and none of them is worth a redraw.
   */
  apply(move: EditMove, selected: readonly Vert[], proportional: ProportionalOptions): boolean {
    const carried = proportional.enabled && proportional.radius > 0;
    const key = JSON.stringify([
      move,
      carried && proportional.radius,
      carried && proportional.falloff,
    ]);
    if (key === this.key) return false;
    this.key = key;

    for (const vert of this.moved) vert.co = this.origins.get(vert) ?? vert.co;

    const previous = this.spread;
    const influence = carried ? this.measure(selected, proportional) : null;
    // A falloff drawn in, or switched off, leaves vertices back where they
    // began that no step below will touch, so their faces turn back here.
    if (previous?.influence !== influence && this.moved.length > selected.length) {
      this.mesh.computeNormals(this.moved);
    }
    if (!carried) this.spread = null;

    const moving = influence
      ? [...selected, ...influence.reached.map(({ vert }) => vert)]
      : selected;
    for (const vert of moving) {
      if (!this.origins.has(vert)) this.origins.set(vert, { ...vert.co });
    }

    const spread = influence ?? undefined;
    if (move.kind === 'translate') {
      translateVerts(this.mesh, selected, move.offset, spread);
    } else if (move.kind === 'rotate') {
      rotateVerts(this.mesh, selected, move.axis, move.angle, move.pivot, spread);
    } else {
      scaleVerts(this.mesh, selected, move.factor, move.pivot, spread);
    }

    this.moved = moving;
    this.move = move;
    this.proportional = carried ? proportional : null;
    return true;
  }

  private measure(selected: readonly Vert[], proportional: ProportionalOptions) {
    const held = this.spread;
    if (held && held.radius === proportional.radius && held.falloff === proportional.falloff) {
      return held.influence;
    }
    const influence = proportionalInfluence(this.mesh, selected, proportional);
    this.spread = { radius: proportional.radius, falloff: proportional.falloff, influence };
    return influence;
  }

  /**
   * The operation that does what the transform did, or null when it ended
   * where it began. `median` says the pivot was the middle of the selection,
   * which the operations turn and scale about when given none.
   */
  call(median: boolean): EditMoveCall | null {
    const move = this.move;
    if (!move) return null;

    const params: Record<string, unknown> = {};
    let name: EditMoveCall['name'];
    if (move.kind === 'translate') {
      if (isZero(move.offset)) return null;
      name = 'translate';
      params.offset = move.offset;
    } else if (move.kind === 'rotate') {
      if (Math.abs(move.angle) < NOTHING) return null;
      name = 'rotate';
      Object.assign(params, axisAndAngle(move.axis, move.angle));
      if (!median) params.pivot = move.pivot;
    } else {
      const { x, y, z } = move.factor;
      if (isZero({ x: x - 1, y: y - 1, z: z - 1 })) return null;
      name = 'scale';
      params.scale = move.factor;
      if (!median) params.pivot = move.pivot;
    }

    if (this.proportional) {
      params.proportional = this.proportional.radius;
      if (this.proportional.falloff !== 'smooth') params.falloff = this.proportional.falloff;
    }
    return { name, params };
  }
}

const isZero = (v: Vec3) =>
  Math.abs(v.x) < NOTHING && Math.abs(v.y) < NOTHING && Math.abs(v.z) < NOTHING;

/**
 * The axis as a letter when it lies along one, the way a person would write
 * it: a turn about -Y is a turn the other way about "y". Any other direction
 * stays a direction.
 */
function axisAndAngle(axis: Vec3, angle: number): { axis: string | Vec3; angle: number } {
  const degrees = radToDeg(angle);
  for (const letter of ['x', 'y', 'z'] as const) {
    const along = axis[letter];
    if (Math.abs(Math.abs(along) - 1) < 1e-9) {
      return { axis: letter, angle: along < 0 ? -degrees : degrees };
    }
  }
  return { axis, angle: degrees };
}
