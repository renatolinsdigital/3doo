import { useLayoutEffect, useRef } from 'react';

import type { Axis } from '@kernel/index';
import { useTooltipTrigger } from '@shared/hooks/useTooltipTrigger';
import { useEditorStore } from '@store/index';
import { type AxisMark, projectViewAxes, subscribeViewAxes } from '@viewport/index';

import './ViewAxes.scss';

/** Half the viewBox, and how far out from it the ends sit. */
const CENTRE = 50;
const SPOKE = 30;

/** Ball radii at full size. A negative end is the smaller of the two. */
const POSITIVE_RADIUS = 11.5;
const NEGATIVE_RADIUS = 8;

/**
 * How much smaller an end gets as it goes away from the viewer, and how far it
 * fades.
 *
 * The only cue left once an axis points straight at you, where its spoke has no
 * length to say which end is which.
 */
const DEPTH_SCALE = 0.22;
const DEPTH_FADE = 0.45;

/** What is left of an axis the running transform is not using. */
const UNPINNED_OPACITY = 0.16;

interface Ball {
  axis: Axis;
  negative: boolean;
  /** The view clicking it takes, named the way the shortcut list names it. */
  view: string;
}

/** Both ends of all three axes. Paint order is decided per frame, not here. */
const BALLS: readonly Ball[] = [
  { axis: 'x', negative: false, view: 'RIGHT' },
  { axis: 'x', negative: true, view: 'LEFT' },
  { axis: 'y', negative: false, view: 'TOP' },
  { axis: 'y', negative: true, view: 'BOTTOM' },
  { axis: 'z', negative: false, view: 'FRONT' },
  { axis: 'z', negative: true, view: 'BACK' },
];

const keyOf = (axis: Axis, negative: boolean) => `${negative ? '-' : ''}${axis}`;

/**
 * The axis widget in the corner of the viewport.
 *
 * Blender's navigation gizmo read through this app's own palette: six ends,
 * the near ones drawn over the far ones, turning with the camera so the corner
 * always says which way the world is facing. The lettered ends are the positive
 * directions and the hollow ones the negative, and clicking any of them looks
 * from that side, the same jump Ctrl+1, Ctrl+3 and 7 make.
 *
 * It also says what a transform is about to move: pin a drag to an axis and the
 * other two fade back, so a Y pressed for an X shows in the corner rather than
 * only in the result.
 *
 * The camera moves on every orbit tick, which is no place for React state. The
 * markup is rendered once and the positions are written to the DOM from the
 * viewport's own frame channel, the same way the viewport keeps React off the
 * per-frame path everywhere else.
 */
export function ViewAxes() {
  const svgRef = useRef<SVGSVGElement>(null);
  const groups = useRef(new Map<string, SVGGElement>());
  const spokes = useRef(new Map<Axis, SVGLineElement>());
  const order = useRef('');

  // Layout rather than effect: the first frame arrives the moment this
  // subscribes, and a plain effect would let the six ends paint at the corner
  // of the box for one frame before they were placed.
  useLayoutEffect(
    () =>
      subscribeViewAxes(({ basis, axes }) => {
        const marks = projectViewAxes(basis);

        for (const mark of marks) {
          const group = groups.current.get(keyOf(mark.axis, mark.negative));
          if (group) paintBall(group, mark, axes);
          if (!mark.negative) paintSpoke(spokes.current.get(mark.axis), mark, axes);
        }

        // SVG has no z-index: what is painted last is what sits on top, so the
        // near ends have to be moved to the end of the list. Only when the
        // order actually changes, since moving a node is a real DOM write.
        const svg = svgRef.current;
        const next = marks.map((mark) => keyOf(mark.axis, mark.negative)).join(' ');
        if (!svg || next === order.current) return;
        order.current = next;
        for (const mark of marks) {
          const group = groups.current.get(keyOf(mark.axis, mark.negative));
          if (group) svg.append(group);
        }
      }),
    [],
  );

  return (
    // Only the ends themselves take the pointer: a drag anywhere else in the
    // corner still orbits the scene under it.
    <div className="view-axes">
      <svg className="view-axes__plate" viewBox="0 0 100 100" ref={svgRef}>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <line
            key={axis}
            className={`view-axes__spoke view-axes__spoke--${axis}`}
            x1={CENTRE}
            y1={CENTRE}
            x2={CENTRE}
            y2={CENTRE}
            ref={(node) => {
              if (node) spokes.current.set(axis, node);
              else spokes.current.delete(axis);
            }}
          />
        ))}

        {BALLS.map((ball) => (
          <AxisBall
            key={keyOf(ball.axis, ball.negative)}
            ball={ball}
            register={(node) => {
              const key = keyOf(ball.axis, ball.negative);
              if (node) groups.current.set(key, node);
              else groups.current.delete(key);
            }}
          />
        ))}
      </svg>
    </div>
  );
}

interface AxisBallProps {
  ball: Ball;
  register: (node: SVGGElement | null) => void;
}

/**
 * One end of one axis.
 *
 * A component of its own so each end can carry its own hint, which a hook
 * cannot do from inside a loop.
 */
function AxisBall({ ball, register }: AxisBallProps) {
  const setAxisView = useEditorStore((state) => state.setAxisView);
  const sign = ball.negative ? '-' : '+';
  const tooltip = useTooltipTrigger(
    `${ball.view} view: look at the scene from ${sign}${ball.axis.toUpperCase()}`,
  );

  return (
    <g
      className={`view-axes__ball view-axes__ball--${ball.axis}${
        ball.negative ? ' view-axes__ball--negative' : ''
      }`}
      // Named rather than focusable: the same views are on Ctrl+1, Ctrl+3 and
      // 7, and six tab stops in front of the viewport would be in the way.
      role="button"
      aria-label={`${ball.view} view`}
      onClick={() => setAxisView(ball.axis, ball.negative)}
      ref={register}
      {...tooltip}
    >
      <circle r={ball.negative ? NEGATIVE_RADIUS : POSITIVE_RADIUS} />
      {ball.negative ? null : <text>{ball.axis.toUpperCase()}</text>}
    </g>
  );
}

/** Whether a running transform is using this axis. Nothing pinned lights them all. */
function lit(axis: Axis, axes: readonly Axis[] | null): boolean {
  return !axes || axes.includes(axis);
}

/** Moves one end to where the camera puts it, and sizes it by how near it is. */
function paintBall(group: SVGGElement, mark: AxisMark, axes: readonly Axis[] | null): void {
  const near = (mark.depth + 1) / 2;
  const scale = 1 - DEPTH_SCALE * (1 - near);
  const fade = 1 - DEPTH_FADE * (1 - near);

  group.setAttribute(
    'transform',
    `translate(${CENTRE + mark.x * SPOKE} ${CENTRE + mark.y * SPOKE}) scale(${scale})`,
  );
  group.setAttribute('opacity', `${fade * (lit(mark.axis, axes) ? 1 : UNPINNED_OPACITY)}`);
}

/** Runs the spoke from the centre out to its lettered end. */
function paintSpoke(
  line: SVGLineElement | undefined,
  mark: AxisMark,
  axes: readonly Axis[] | null,
): void {
  if (!line) return;
  line.setAttribute('x2', `${CENTRE + mark.x * SPOKE}`);
  line.setAttribute('y2', `${CENTRE + mark.y * SPOKE}`);
  line.setAttribute('opacity', `${lit(mark.axis, axes) ? 1 : UNPINNED_OPACITY}`);
}
