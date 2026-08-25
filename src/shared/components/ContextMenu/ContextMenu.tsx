import { useEffect, useRef } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';

import './ContextMenu.scss';

export interface ContextMenuItem {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export type ContextMenuEntry = ContextMenuItem | { id: string; separator: true };

export interface ContextMenuProps {
  /** Position within the menu's containing block, in pixels. */
  x: number;
  y: number;
  label: string;
  entries: readonly ContextMenuEntry[];
  onClose: () => void;
}

function isSeparator(entry: ContextMenuEntry): entry is { id: string; separator: true } {
  return 'separator' in entry;
}

/**
 * A pointer-anchored menu.
 *
 * Sized and placed by the caller, but it clamps itself into the containing
 * block after mounting: a menu opened near the right or bottom edge would
 * otherwise run off the viewport, and the entries at the end are the ones a
 * user reaches for last.
 */
export function ContextMenu({ x, y, label, entries, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;

    const parent = menu.offsetParent as HTMLElement | null;
    const width = parent?.clientWidth ?? window.innerWidth;
    const height = parent?.clientHeight ?? window.innerHeight;
    menu.style.left = `${Math.max(0, Math.min(x, width - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, height - menu.offsetHeight - 4))}px`;

    // The container takes focus, not the first entry: focusing a menu item
    // fires its hint immediately, and the tooltip lands on top of the entries
    // below it the moment the menu opens.
    menu.focus();
  }, [x, y]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  return (
    <div
      className="context-menu"
      role="menu"
      aria-label={label}
      ref={ref}
      tabIndex={-1}
      style={{ left: x, top: y }}
    >
      {entries.map((entry) =>
        isSeparator(entry) ? (
          <hr key={entry.id} className="context-menu__rule" />
        ) : (
          <ContextMenuButton key={entry.id} item={entry} onClose={onClose} />
        ),
      )}
    </div>
  );
}

function ContextMenuButton({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const tooltip = useTooltipTrigger(item.hint);
  return (
    <button
      type="button"
      role="menuitem"
      className="context-menu__item"
      // Disabled entries stay in place and keep their hint, which is what says
      // why the click found nothing to snap to.
      aria-disabled={item.disabled || undefined}
      onClick={
        item.disabled
          ? undefined
          : () => {
              item.onSelect();
              onClose();
            }
      }
      {...tooltip}
    >
      {item.label}
    </button>
  );
}
