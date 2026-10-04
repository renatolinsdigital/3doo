import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLongPressMenu } from './useLongPressMenu';

function Row({ onMenu, onClick }: { onMenu: () => void; onClick: () => void }) {
  useLongPressMenu();
  return (
    <ul>
      <li
        data-context-menu=""
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu();
        }}
      >
        <button type="button" onClick={onClick}>
          CUBE
        </button>
      </li>
      <li>
        <button type="button">PLAIN</button>
      </li>
    </ul>
  );
}

describe('useLongPressMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the menu of what a finger rests on, at the finger', () => {
    const onMenu = vi.fn();
    const onClick = vi.fn();
    render(<Row onMenu={onMenu} onClick={onClick} />);
    const cube = screen.getByRole('button', { name: 'CUBE' });

    fireEvent.pointerDown(cube, { pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 30 });
    act(() => vi.advanceTimersByTime(600));
    expect(onMenu).toHaveBeenCalledOnce();

    // Lifting off the menu that just opened is not a press on the row.
    fireEvent.pointerUp(cube, { pointerId: 1, pointerType: 'touch' });
    fireEvent.click(cube);
    expect(onClick).not.toHaveBeenCalled();

    // Android's own menu event for the same press is swallowed.
    const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    cube.dispatchEvent(native);
    expect(onMenu).toHaveBeenCalledOnce();
  });

  it('does nothing for a tap, a mouse, a slide, or a row with no menu', () => {
    const onMenu = vi.fn();
    const onClick = vi.fn();
    render(<Row onMenu={onMenu} onClick={onClick} />);
    const cube = screen.getByRole('button', { name: 'CUBE' });

    fireEvent.pointerDown(cube, { pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerUp(cube, { pointerId: 1, pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.click(cube);
    expect(onClick).toHaveBeenCalledOnce();

    fireEvent.pointerDown(cube, { pointerId: 2, pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(600));

    fireEvent.pointerDown(cube, { pointerId: 3, pointerType: 'touch', clientX: 0, clientY: 0 });
    fireEvent.pointerMove(cube, { pointerId: 3, pointerType: 'touch', clientX: 0, clientY: 30 });
    act(() => vi.advanceTimersByTime(600));

    fireEvent.pointerDown(screen.getByRole('button', { name: 'PLAIN' }), {
      pointerId: 4,
      pointerType: 'touch',
    });
    act(() => vi.advanceTimersByTime(600));

    expect(onMenu).not.toHaveBeenCalled();
  });

  it('lets go of the window when it unmounts', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    renderHook(() => useLongPressMenu()).unmount();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    remove.mockRestore();
  });
});
