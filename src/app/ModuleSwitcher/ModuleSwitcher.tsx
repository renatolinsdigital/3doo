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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  return (
    <div className="module-switcher" ref={ref}>
      <button
        type="button"
        className="module-switcher__brand"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${current.brand}, switch module`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="module-switcher__name">{current.brand}</span>
        <span className="module-switcher__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="module-switcher__menu" role="menu" aria-label="Modules">
          {APP_MODULES.map((module) => (
            <button
              key={module.id}
              type="button"
              role="menuitem"
              className="module-switcher__item"
              aria-current={module.id === current.id || undefined}
              onClick={() => {
                setOpen(false);
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
