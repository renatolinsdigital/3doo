import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '../useEditorStore';

describe('viewLost', () => {
  beforeEach(() => {
    useEditorStore.setState({ viewLost: false });
  });

  it('defaults to false', () => {
    expect(useEditorStore.getState().viewLost).toBe(false);
  });

  it('is set by the viewport once the camera scrolls out of comfortable range', () => {
    useEditorStore.getState().setViewLost(true);
    expect(useEditorStore.getState().viewLost).toBe(true);
  });

  it('clears once the camera comes back', () => {
    useEditorStore.getState().setViewLost(true);
    useEditorStore.getState().setViewLost(false);
    expect(useEditorStore.getState().viewLost).toBe(false);
  });
});
