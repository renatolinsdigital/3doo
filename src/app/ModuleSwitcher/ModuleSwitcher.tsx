import { useEffect, useRef, useState } from 'react';

import { APP_MODULES, moduleForPath } from '../modules';
import { navigate, usePathname } from '../router';

import './ModuleSwitcher.scss';

/**
 * The brand plate, doubling as the switch between modules.
 *
 * The plate is the one element every module shares, so it is also the one place
 * a user can always reach the others from, which is why the module name lives
 * in it rather than in a separate nav bar each module would have to repeat.
 */
export function ModuleSwitcher() {
  const pathname = usePathname();
  const current = moduleForPath(pathname);
  // Where the menu hangs, read off the plate as it opens. Fixed to the window
  // rather than hung off the plate, because the top bar on a narrow screen is
  // a row that scrolls sideways, and a scrolling box crops what hangs out of it.
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(null);
    };
    // A menu fixed to the window stays put when the plate it hangs from moves,
    // so the bar scrolling or the window resizing puts it away instead.
    const onMove = () => setOpen(null);

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  return (
    <div className="module-switcher" ref={ref}>
      <button
        type="button"
        className="module-switcher__brand"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-label={`${current.brand}, switch module`}
        onClick={(event) => {
          if (open) {
            setOpen(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setOpen({ top: rect.bottom + 4, left: rect.left });
        }}
      >
        <span className="module-switcher__name">{current.brand}</span>
        <span className="module-switcher__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div
          className="module-switcher__menu"
          role="menu"
          aria-label="Modules"
          style={{ top: open.top, left: open.left }}
        >
          {APP_MODULES.map((module) => (
            <button
              key={module.id}
              type="button"
              role="menuitem"
              className="module-switcher__item"
              aria-current={module.id === current.id || undefined}
              onClick={() => {
                setOpen(null);
                navigate(module.path);
              }}
            >
              <span className="module-switcher__item-label">{module.label}</span>
              <span className="module-switcher__item-summary">{module.summary}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
