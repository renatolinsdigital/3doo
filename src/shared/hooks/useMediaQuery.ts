import { useCallback, useSyncExternalStore } from 'react';

/**
 * The layout the panels collapse into drawers at, the same width as
 * `tablet-down` in `responsive-mixins.scss`. The two have to agree: the
 * stylesheet hides the columns at this width and the shell renders the
 * buttons that bring them back.
 */
export const COMPACT_LAYOUT = '(max-width: 1023px)';

/**
 * A phone either way up: upright, only one drawer fits beside the rail, and on
 * its side there is no height for a drawer to share with the model. The same
 * as `phone` in `responsive-mixins.scss`.
 */
export const NARROW_LAYOUT = '(max-width: 639px), (max-height: 499px)';

/**
 * A finger is the main way in: a phone or a tablet without a mouse.
 *
 * The primary pointer only, so a laptop with a touch screen keeps the desktop
 * layout it was built for, while its screen still takes the two-finger
 * gestures, which the canvas reads from any touch whatever this says.
 */
export const TOUCH_FIRST = '(pointer: coarse)';

/**
 * Whether a media query matches, kept current as the window changes.
 *
 * False wherever there is no `matchMedia` to ask, which is a test runner, so a
 * component reads as it would on the desktop unless the test says otherwise.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => matches(query),
    () => false,
  );
}

/** The same question asked once, outside React. */
export function matches(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}
