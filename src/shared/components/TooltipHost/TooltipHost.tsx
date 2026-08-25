import { type RefObject, useLayoutEffect, useRef } from 'react';

import { useEditorStore } from '@store/index';

import './TooltipHost.scss';

/** Clearance from the anchor and from the edges of the area hints are kept in. */
const MARGIN = 8;

export interface TooltipHostProps {
  /**
   * Area hints are kept inside; the window when omitted. The shell passes its
   * main region so a hint on a control at the bottom of a panel is never laid
   * over the status bar.
   */
  bounds?: RefObject<HTMLElement>;
}

/** Renders whatever hint is currently reported by `useTooltipTrigger`. */
export function TooltipHost({ bounds }: TooltipHostProps) {
  const hint = useEditorStore((state) => state.hint);
  const ref = useRef<HTMLDivElement>(null);

  // Placed once the text is in the DOM rather than from an assumed size: hints
  // wrap to one, two or three lines, and a guessed height is what let them hang
  // off the bottom of their area. Writing straight to the node keeps this to a
  // single pre-paint pass, so the hint never shows up in the wrong place first.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!hint || !node) return;

    const { width, height } = node.getBoundingClientRect();
    const area = bounds?.current?.getBoundingClientRect() ?? {
      left: 0,
      right: window.innerWidth,
      top: 0,
      bottom: window.innerHeight,
    };

    const below = hint.y + MARGIN;
    const above = hint.anchorTop - height - MARGIN;
    const flip = below + height + MARGIN > area.bottom && above >= area.top;

    const left = Math.min(hint.x, area.right - width - MARGIN);
    node.style.left = `${Math.max(area.left + MARGIN, left)}px`;
    node.style.top = `${Math.max(area.top + MARGIN, flip ? above : below)}px`;
    node.style.visibility = 'visible';
  }, [hint, bounds]);

  if (!hint) return null;

  return (
    <div
      className="tooltip-host"
      role="tooltip"
      ref={ref}
      // Measured from a fixed spot, then revealed where it fits by the effect.
      style={{ left: 0, top: 0, visibility: 'hidden' }}
    >
      {hint.text}
    </div>
  );
}
