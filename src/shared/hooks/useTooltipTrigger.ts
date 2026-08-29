import { useEffect, useRef } from 'react';

import { useEditorStore } from '@store/index';

const HOVER_DELAY_MS = 450;

type Rect = { left: number; top: number; bottom: number };
type Anchor = { getBoundingClientRect: () => Rect };

export interface TooltipTriggerHandlers {
  onMouseEnter?: (event: React.MouseEvent<Anchor>) => void;
  onMouseLeave?: () => void;
  onPointerDown?: () => void;
  onFocus?: (event: React.FocusEvent<Anchor>) => void;
  onBlur?: () => void;
}

/**
 * Hover/focus handlers for the shared hint tooltip.
 *
 * Centralised here rather than duplicated per component: a single `TooltipHost`
 * (mounted once, like `ToastHost`) renders whatever is currently hovered, so
 * showing a hint is just reporting a rect rather than mounting a floating
 * element per control. Hovering waits out a short delay so hints do not flash
 * during normal mouse travel; focus shows immediately for keyboard users.
 */
export function useTooltipTrigger(text?: string): TooltipTriggerHandlers {
  const showHint = useEditorStore((state) => state.showHint);
  const hideHint = useEditorStore((state) => state.hideHint);
  const timerRef = useRef<number | undefined>(undefined);
  const showingRef = useRef(false);
  const pressedRef = useRef(false);

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      // A control can be unmounted by its own click (a menu entry, a dialog
      // button) and then never receives the mouseleave that would clear its
      // hint, leaving the tooltip stranded over the viewport. Only the trigger
      // whose hint is actually up clears it, so a control unmounting elsewhere
      // cannot wipe the hint of whatever the pointer has moved on to.
      if (showingRef.current) useEditorStore.getState().hideHint();
    },
    [],
  );

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

  return {
    onMouseEnter: (event) => {
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
    onPointerDown: () => {
      pressedRef.current = true;
      hide();
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
      hide();
    },
  };
}
