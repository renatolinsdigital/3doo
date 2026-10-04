import { useEffect } from 'react';

/** How long a finger rests before it counts as the right button, as a phone's long press does. */
const LONG_PRESS_MS = 500;

/** How far it may drift in that time and still be resting rather than scrolling. */
const SLOP_PX = 10;

/**
 * How long after the finger of a long press lifts the click its release makes,
 * and the menu event Android raises for it, are still swallowed.
 */
const AFTERMATH_MS = 800;

/**
 * Opens right-click menus with a long press, on every touch screen.
 *
 * Anything that answers a right-click with a menu of its own marks itself
 * with `data-context-menu`, and a finger resting on it for half a second sends
 * it the `contextmenu` event a right-click would have. Android raises one of
 * its own for a long press and iOS raises none at all, so this makes the one
 * event both, and swallows Android's when it comes after, so a menu never
 * opens twice. The click the finger's release makes is swallowed too, since
 * lifting off a menu that has just opened is not a press on what is under it.
 *
 * The viewport is left out: it reads its own fingers (see `Viewport`), where a
 * second finger arriving turns the press into a camera move instead.
 */
export function useLongPressMenu(): void {
  useEffect(() => {
    let timer: number | undefined;
    let press: { id: number; x: number; y: number; target: Element } | null = null;
    /** The finger whose long press opened a menu, until it lifts. */
    let spent: number | null = null;
    /** When that finger lifted. */
    let liftedAt = -Infinity;
    /** The menu events this hook raised itself, which are the ones to let through. */
    const raised = new WeakSet<Event>();

    const cancel = () => {
      window.clearTimeout(timer);
      press = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      cancel();
      if (event.pointerType !== 'touch' || !(event.target instanceof Element)) return;
      const host = event.target.closest('[data-context-menu]');
      if (!host || isTextEntry(event.target)) return;

      press = { id: event.pointerId, x: event.clientX, y: event.clientY, target: event.target };
      timer = window.setTimeout(() => {
        if (!press) return;
        const { id, target, x, y } = press;
        press = null;
        spent = id;
        const menu = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 2,
        });
        raised.add(menu);
        target.dispatchEvent(menu);
      }, LONG_PRESS_MS);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.id) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > SLOP_PX) cancel();
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (press?.id === event.pointerId) cancel();
      if (spent === event.pointerId) {
        spent = null;
        liftedAt = performance.now();
      }
    };

    const swallow = (event: Event) => {
      if (spent === null && performance.now() - liftedAt > AFTERMATH_MS) return;
      event.preventDefault();
      event.stopPropagation();
    };

    // Any menu event but ours: Android's long press. Ours has fired or is
    // about to, so this one is either a repeat or a race to be first.
    const onContextMenu = (event: MouseEvent) => {
      if (raised.has(event)) return;
      if (press) {
        // Android got there first: let its event through and drop ours.
        spent = press.id;
        cancel();
        return;
      }
      swallow(event);
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('pointercancel', onPointerEnd, true);
    window.addEventListener('click', swallow, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      cancel();
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, []);
}

/** Fields that type keep the phone's own long press, which is where paste lives. */
function isTextEntry(target: Element): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement)
    return target.type !== 'button' && target.type !== 'color';
  return target instanceof HTMLElement && target.isContentEditable;
}
