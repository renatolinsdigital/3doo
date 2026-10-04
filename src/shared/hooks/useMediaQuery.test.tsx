import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { mockMatchMedia } from '@/tests/matchMedia';

import { COMPACT_LAYOUT, TOUCH_FIRST, matches, useMediaQuery } from './useMediaQuery';

describe('useMediaQuery', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('reads as the desktop where there is no matchMedia to ask', () => {
    expect(renderHook(() => useMediaQuery(COMPACT_LAYOUT)).result.current).toBe(false);
    expect(matches(TOUCH_FIRST)).toBe(false);
  });

  it('answers what the window says about each query', () => {
    restore = mockMatchMedia([TOUCH_FIRST]);
    expect(renderHook(() => useMediaQuery(TOUCH_FIRST)).result.current).toBe(true);
    expect(renderHook(() => useMediaQuery(COMPACT_LAYOUT)).result.current).toBe(false);
    expect(matches(TOUCH_FIRST)).toBe(true);
  });
});
