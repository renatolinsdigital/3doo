import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { ToastHost } from './ToastHost';

function push(message: string) {
  act(() => useEditorStore.getState().pushToast('warning', message));
}

describe('ToastHost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.setState({ toasts: [] });
  });

  afterEach(() => {
    act(() => useEditorStore.setState({ toasts: [] }));
    vi.useRealTimers();
  });

  it('shows nothing while the queue is empty', () => {
    const { container } = render(<ToastHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it('holds the overflow back until a slot frees up', () => {
    render(<ToastHost />);
    for (const message of ['One', 'Two', 'Three', 'Four', 'Five']) push(message);

    expect(screen.queryByText('Five')).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3000));

    expect(screen.queryByText('One')).not.toBeInTheDocument();
    expect(screen.getByText('Five')).toBeInTheDocument();
  });

  it('draws one toast for a message raised over and over', () => {
    render(<ToastHost />);
    for (let raised = 0; raised < 8; raised += 1) {
      push('Select an object before entering edit mode');
    }

    expect(screen.getAllByText('Select an object before entering edit mode')).toHaveLength(1);
  });
});
