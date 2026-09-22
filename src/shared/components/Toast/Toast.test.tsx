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

  it('keeps its countdown across a rerender with a fresh callback', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast variant="info" message="Saved" duration={3000} onDismiss={() => onDismiss()} />,
    );

    vi.advanceTimersByTime(2000);
    rerender(
      <Toast variant="info" message="Saved" duration={3000} onDismiss={() => onDismiss()} />,
    );
    vi.advanceTimersByTime(1000);

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('starts the countdown over when the message is raised again', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast variant="info" message="Saved" duration={3000} issued={1} onDismiss={onDismiss} />,
    );

    vi.advanceTimersByTime(2000);
    rerender(
      <Toast variant="info" message="Saved" duration={3000} issued={2} onDismiss={onDismiss} />,
    );

    vi.advanceTimersByTime(2000);
    expect(onDismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
