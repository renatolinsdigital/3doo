import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toast } from './Toast';

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the message', () => {
    render(<Toast variant="success" message="Exported model.obj" onDismiss={() => {}} />);
    expect(screen.getByText('Exported model.obj')).toBeInTheDocument();
  });

  it('announces errors assertively', () => {
    render(<Toast variant="error" message="Export failed" onDismiss={() => {}} />);
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
  });

  it('announces non-errors politely', () => {
    render(<Toast variant="info" message="Saved" onDismiss={() => {}} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('auto-dismisses without needing a click', () => {
    const onDismiss = vi.fn();
    render(<Toast variant="info" message="Saved" duration={3000} onDismiss={onDismiss} />);

    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
