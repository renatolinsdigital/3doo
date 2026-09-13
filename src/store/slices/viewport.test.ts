import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '../useEditorStore';

describe('viewLost', () => {
  beforeEach(() => {
    useEditorStore.setState({ viewLost: null });
  });

  it('defaults to nothing lost', () => {
    expect(useEditorStore.getState().viewLost).toBeNull();
  });

  it('is set by the viewport once the camera scrolls out of comfortable range', () => {
    useEditorStore.getState().setViewLost('far');
    expect(useEditorStore.getState().viewLost).toBe('far');
  });

  it('carries the other way of losing the scene too', () => {
    useEditorStore.getState().setViewLost('stuck');
    expect(useEditorStore.getState().viewLost).toBe('stuck');
  });

  it('clears once the camera comes back', () => {
    useEditorStore.getState().setViewLost('far');
    useEditorStore.getState().setViewLost(null);
    expect(useEditorStore.getState().viewLost).toBeNull();
  });
});
