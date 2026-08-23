import { useEffect, useRef } from 'react';

import { useEditorStore } from '@store/index';

const HOVER_DELAY_MS = 450;

type Anchor = { getBoundingClientRect: () => { left: number; top: number; bottom: number } };

export interface TooltipTriggerHandlers {
  onMouseEnter?: (event: React.MouseEvent<Anchor>) => void;
  onMouseLeave?: () => void;
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

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  if (!text) return {};

  return {
    onMouseEnter: (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => showHint(text, rect), HOVER_DELAY_MS);
    },
    onMouseLeave: () => {
      window.clearTimeout(timerRef.current);
      hideHint();
    },
    onFocus: (event) => showHint(text, event.currentTarget.getBoundingClientRect()),
    onBlur: () => hideHint(),
  };
}
