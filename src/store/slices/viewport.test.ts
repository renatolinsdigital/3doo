import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '../useEditorStore';
import { axisViewName } from './viewport';

describe('axis views', () => {
  beforeEach(() => {
    useEditorStore.setState({ axisViewRequest: null, status: 'Ready' });
  });

  it('names both ends of all three axes', () => {
    expect([
      axisViewName('y', false),
      axisViewName('y', true),
      axisViewName('x', true),
      axisViewName('x', false),
      axisViewName('z', false),
      axisViewName('z', true),
    ]).toEqual(['Top', 'Bottom', 'Left', 'Right', 'Front', 'Back']);
  });

  it('asks the viewport for a view and says which one in the status bar', () => {
    useEditorStore.getState().setAxisView('y');
    expect(useEditorStore.getState().axisViewRequest).toMatchObject({
      axis: 'y',
      negative: false,
    });
    expect(useEditorStore.getState().status).toBe('Top view');
  });

  it('carries the negative end through', () => {
    useEditorStore.getState().setAxisView('z', true);
    expect(useEditorStore.getState().axisViewRequest).toMatchObject({ axis: 'z', negative: true });
    expect(useEditorStore.getState().status).toBe('Back view');
  });

  it('asks again when the same view is picked twice', () => {
    useEditorStore.getState().setAxisView('x');
    const first = useEditorStore.getState().axisViewRequest?.nonce;
    useEditorStore.getState().setAxisView('x');
    expect(useEditorStore.getState().axisViewRequest?.nonce).not.toBe(first);
  });
});

describe('the keyboard orbit', () => {
  beforeEach(() => {
    useEditorStore.setState({ orbitRequest: null, status: 'Ready' });
  });

  it('asks the viewport for a step and names it in the status bar', () => {
    useEditorStore.getState().orbitView('left');

    expect(useEditorStore.getState().orbitRequest).toMatchObject({ step: 'left' });
    expect(useEditorStore.getState().status).toBe('Orbit left');
  });

  it('carries the walk round to the far side on the same channel', () => {
    useEditorStore.getState().orbitView('opposite');

    expect(useEditorStore.getState().orbitRequest).toMatchObject({ step: 'opposite' });
    expect(useEditorStore.getState().status).toBe('Opposite side');
  });

  it('asks again on every press, since a step is relative', () => {
    // Nothing in the request says where the camera is, so two presses of the
    // same key have to arrive as two requests or the second is swallowed.
    useEditorStore.getState().orbitView('up');
    const first = useEditorStore.getState().orbitRequest?.nonce;
    useEditorStore.getState().orbitView('up');

    expect(useEditorStore.getState().orbitRequest?.nonce).not.toBe(first);
  });
});

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
