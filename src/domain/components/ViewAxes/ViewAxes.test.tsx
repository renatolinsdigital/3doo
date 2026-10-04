import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';
import { DEFAULT_BASIS, publishViewAxes, subscribeViewAxesOrbit } from '@viewport/index';

import { ViewAxes } from './ViewAxes';

/** The front view, with nothing pinned, unless a test says otherwise. */
function publish(axes: readonly ('x' | 'y' | 'z')[] | null = null) {
  act(() => publishViewAxes({ basis: DEFAULT_BASIS, axes }));
}

const ballFor = (view: string) => screen.getByRole('button', { name: `${view} view` });

const opacityOf = (view: string) => Number(ballFor(view).getAttribute('opacity'));

describe('ViewAxes', () => {
  beforeEach(() => {
    useEditorStore.setState({ axisViewRequest: null });
  });

  it('seats the axis pointing at the camera in the middle', () => {
    render(<ViewAxes />);
    publish();

    expect(ballFor('FRONT')).toHaveAttribute(
      'transform',
      expect.stringContaining('translate(50 50'),
    );
    // One whole spoke out from the centre of a 100-unit box.
    expect(ballFor('RIGHT')).toHaveAttribute(
      'transform',
      expect.stringContaining('translate(80 50'),
    );
    expect(ballFor('TOP')).toHaveAttribute('transform', expect.stringContaining('translate(50 20'));
  });

  it('paints the near end over the far one', () => {
    render(<ViewAxes />);
    publish();

    const plate = ballFor('FRONT').parentElement ?? document.body;
    const painted = [...plate.children].map((node) => node.getAttribute('aria-label'));
    expect(painted.indexOf('FRONT view')).toBeGreaterThan(painted.indexOf('BACK view'));
  });

  it('looks from the side that was clicked', async () => {
    render(<ViewAxes />);
    publish();

    await userEvent.click(ballFor('LEFT'));

    expect(useEditorStore.getState().axisViewRequest).toMatchObject({ axis: 'x', negative: true });
  });

  it('fades the axes a pinned transform is leaving alone, and puts them back', () => {
    render(<ViewAxes />);
    publish();
    const free = opacityOf('TOP');

    publish(['x']);

    // X is pinned, so it keeps the weight it had and the other two drop away.
    expect(opacityOf('RIGHT')).toBeCloseTo(free);
    expect(opacityOf('TOP')).toBeLessThan(free / 3);
    expect(opacityOf('BOTTOM')).toBeLessThan(free / 3);

    publish();
    expect(opacityOf('TOP')).toBeCloseTo(free);
  });

  it('orbits the camera when a press is dragged across it', () => {
    render(<ViewAxes />);
    publish();
    const orbit = vi.fn();
    const unsubscribe = subscribeViewAxesOrbit(orbit);
    const plate = ballFor('FRONT').closest('svg') as SVGSVGElement;

    fireEvent.pointerDown(plate, { pointerId: 3, button: 0, clientX: 40, clientY: 40 });
    // Inside the slop: still a click in the making, so nothing turns.
    fireEvent.pointerMove(plate, { pointerId: 3, clientX: 42, clientY: 41 });
    expect(orbit).not.toHaveBeenCalled();

    fireEvent.pointerMove(plate, { pointerId: 3, clientX: 60, clientY: 30 });
    expect(orbit).toHaveBeenCalledWith(20, -10);
    fireEvent.pointerMove(plate, { pointerId: 3, clientX: 65, clientY: 30 });
    expect(orbit).toHaveBeenLastCalledWith(5, 0);
    unsubscribe();
  });

  it('does not jump the view when an orbit is let go over an end', () => {
    render(<ViewAxes />);
    publish();
    const plate = ballFor('FRONT').closest('svg') as SVGSVGElement;

    fireEvent.pointerDown(plate, { pointerId: 4, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(plate, { pointerId: 4, clientX: 50, clientY: 10 });
    fireEvent.pointerUp(plate, { pointerId: 4, clientX: 50, clientY: 10 });
    fireEvent.click(ballFor('RIGHT'));

    expect(useEditorStore.getState().axisViewRequest).toBeNull();

    // The next plain click is a click again.
    fireEvent.pointerDown(plate, { pointerId: 5, button: 0, clientX: 50, clientY: 10 });
    fireEvent.pointerUp(plate, { pointerId: 5, clientX: 50, clientY: 10 });
    fireEvent.click(ballFor('RIGHT'));
    expect(useEditorStore.getState().axisViewRequest).toMatchObject({ axis: 'x', negative: false });
  });
});
