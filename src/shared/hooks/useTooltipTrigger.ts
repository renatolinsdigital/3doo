import { useEffect, useRef } from 'react';

import { useEditorStore } from '@store/index';

const HOVER_DELAY_MS = 450;

/** How long a finger rests on a control before its hint comes up, as a phone's long press does. */
const LONG_PRESS_MS = 500;

/** How far a resting finger may drift and still be resting rather than scrolling. */
const LONG_PRESS_SLOP_PX = 10;

/** How long a hint raised by a finger stays up once the finger lifts, to be read. */
const TOUCH_HINT_LINGER_MS = 1500;

/**
 * How long after a touch the mouse events a browser makes up for it are
 * ignored. A tap is followed by a pretend mouse arriving on what was tapped,
 * and the hint it raised had no mouse to take it away again.
 */
const EMULATED_MOUSE_MS = 1000;

type Rect = { left: number; top: number; bottom: number };
type Anchor = { getBoundingClientRect: () => Rect };

export interface TooltipTriggerHandlers {
  onMouseEnter?: (event: React.MouseEvent<Anchor>) => void;
  onMouseLeave?: () => void;
  onPointerDown?: (event: React.PointerEvent<Anchor>) => void;
  onClickCapture?: (event: React.MouseEvent) => void;
  onFocus?: (event: React.FocusEvent<Anchor>) => void;
  onBlur?: () => void;
}

/** When a finger last touched anything, read by every trigger. */
let lastTouch = -Infinity;
let watchingTouches = false;

function watchTouches(): void {
  if (watchingTouches) return;
  watchingTouches = true;
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType === 'touch') lastTouch = performance.now();
    },
    { capture: true, passive: true },
  );
}

/**
 * Hover/focus handlers for the shared hint tooltip.
 *
 * Centralised here rather than duplicated per component: a single `TooltipHost`
 * (mounted once, like `ToastHost`) renders whatever is currently hovered, so
 * showing a hint is just reporting a rect rather than mounting a floating
 * element per control. Hovering waits out a short delay so hints do not flash
 * during normal mouse travel; focus shows immediately for keyboard users.
 *
 * A touch screen has no hover, so a finger asks the way a phone's own controls
 * are asked: rest it on the control for a moment and the hint comes up, and
 * lifting it then does not press the control. An unavailable control shows
 * its hint on a plain tap, since the tap does nothing else. The exception is anything
 * inside `[data-context-menu]`, where the same long press opens a menu (see
 * `useLongPressMenu`) and a hint over the menu would be in the way.
 */
export function useTooltipTrigger(text?: string): TooltipTriggerHandlers {
  const showHint = useEditorStore((state) => state.showHint);
  const hideHint = useEditorStore((state) => state.hideHint);
  const timerRef = useRef<number | undefined>(undefined);
  const showingRef = useRef(false);
  const pressedRef = useRef(false);
  /** Set when a long press raised the hint, so the click its release makes is not a press. */
  const heldRef = useRef(false);
  /** Takes down the window listeners a finger's press put up. */
  const releaseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    watchTouches();
    return () => {
      window.clearTimeout(timerRef.current);
      releaseRef.current?.();
      // A control can be unmounted by its own click (a menu entry, a dialog
      // button) and then never receives the mouseleave that would clear its
      // hint, leaving the tooltip stranded over the viewport. Only the trigger
      // whose hint is actually up clears it, so a control unmounting elsewhere
      // cannot wipe the hint of whatever the pointer has moved on to.
      if (showingRef.current) useEditorStore.getState().hideHint();
    };
  }, []);

  if (!text) return {};

  const show = (rect: Rect) => {
    showingRef.current = true;
    showHint(text, rect);
  };

  const hide = () => {
    window.clearTimeout(timerRef.current);
    showingRef.current = false;
    hideHint();
  };

  /**
   * Waits for the finger to rest, then raises the hint. Window listeners
   * rather than handlers on the control, which has pointer handlers of its own
   * (a field's scrub, a row's drag) that these must not stand in for.
   */
  const holdForHint = (event: React.PointerEvent<Anchor>) => {
    releaseRef.current?.();
    const rect = event.currentTarget.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    // A control that is unavailable does nothing when tapped, and its hint is
    // the one thing that says why, so it comes up on the tap itself.
    const unavailable =
      event.currentTarget instanceof Element &&
      event.currentTarget.getAttribute('aria-disabled') === 'true';
    timerRef.current = window.setTimeout(
      () => {
        heldRef.current = true;
        show(rect);
      },
      unavailable ? 0 : LONG_PRESS_MS,
    );

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (Math.hypot(move.clientX - start.x, move.clientY - start.y) > LONG_PRESS_SLOP_PX) {
        release();
        window.clearTimeout(timerRef.current);
      }
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) return;
      release();
      window.clearTimeout(timerRef.current);
      if (showingRef.current) timerRef.current = window.setTimeout(hide, TOUCH_HINT_LINGER_MS);
    };
    const release = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onEnd, true);
      releaseRef.current = null;
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('pointercancel', onEnd, true);
    releaseRef.current = release;
  };

  return {
    onMouseEnter: (event) => {
      if (performance.now() - lastTouch < EMULATED_MOUSE_MS) return;
      const rect = event.currentTarget.getBoundingClientRect();
      pressedRef.current = false;
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => show(rect), HOVER_DELAY_MS);
    },
    onMouseLeave: () => {
      pressedRef.current = false;
      hide();
    },
    // Pressing a control dismisses its hint, the way Blender's do: you have
    // read it by the time you click, and it otherwise sits over the panel or
    // the status bar for as long as the pointer stays put.
    onPointerDown: (event) => {
      pressedRef.current = true;
      heldRef.current = false;
      hide();
      if (event.pointerType !== 'touch') return;
      if (event.target instanceof Element && event.target.closest('[data-context-menu]')) return;
      holdForHint(event);
    },
    onClickCapture: (event) => {
      if (!heldRef.current) return;
      heldRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onFocus: (event) => {
      // A press focuses the control too, and that focus would put the hint
      // straight back on screen: only keyboard focus should raise it.
      if (pressedRef.current) {
        pressedRef.current = false;
        return;
      }
      show(event.currentTarget.getBoundingClientRect());
    },
    onBlur: () => {
      pressedRef.current = false;
      // A finger's hint lingers on its own timer after the press that raised
      // it, and the blur that press causes should not cut it short.
      if (heldRef.current) return;
      hide();
    },
  };
}
