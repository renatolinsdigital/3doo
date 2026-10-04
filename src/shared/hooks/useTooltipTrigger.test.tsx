import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from '@shared/components';
import { useEditorStore } from '@store/index';

const hint = () => useEditorStore.getState().hint?.text;

describe('useTooltipTrigger on a touch screen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.setState({ hint: null, tooltipsEnabled: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('raises the hint on a long press, and the release does not press the button', () => {
    const onClick = vi.fn();
    render(<Button label="CUBE" hint="Add a cube" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'CUBE' });

    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(600));
    expect(hint()).toBe('Add a cube');

    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch' });
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    // It stays up long enough to be read, then goes.
    act(() => vi.advanceTimersByTime(2000));
    expect(hint()).toBeUndefined();
  });

  it('presses the button on a plain tap, and leaves no hint behind', () => {
    const onClick = vi.fn();
    render(<Button label="CUBE" hint="Add a cube" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'CUBE' });

    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch' });
    // The pretend mouse a browser sends after a tap is not a hover.
    fireEvent.mouseEnter(button);
    fireEvent.click(button);
    act(() => vi.advanceTimersByTime(1000));

    expect(onClick).toHaveBeenCalledOnce();
    expect(hint()).toBeUndefined();
  });

  it('gives up the long press when the finger slides away, as it does to scroll', () => {
    render(<Button label="CUBE" hint="Add a cube" onClick={() => {}} />);
    const button = screen.getByRole('button', { name: 'CUBE' });

    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0 });
    fireEvent.pointerMove(button, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 40 });
    act(() => vi.advanceTimersByTime(600));

    expect(hint()).toBeUndefined();
  });

  it('says on a tap why an unavailable control does nothing', () => {
    render(<Button label="ASSIGN" hint="Select faces first" disabled onClick={() => {}} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'ASSIGN' }), {
      pointerId: 1,
      pointerType: 'touch',
    });
    act(() => vi.advanceTimersByTime(10));

    expect(hint()).toBe('Select faces first');
  });

  it('leaves a long press inside a menu host to the menu', () => {
    render(
      <div data-context-menu="">
        <Button label="CUBE" hint="Add a cube" onClick={() => {}} />
      </div>,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'CUBE' }), {
      pointerId: 1,
      pointerType: 'touch',
    });
    act(() => vi.advanceTimersByTime(600));

    expect(hint()).toBeUndefined();
  });
});
