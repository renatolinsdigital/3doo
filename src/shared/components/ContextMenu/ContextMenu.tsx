import { useEffect, useId, useRef, type RefObject } from 'react';

import { useTooltipTrigger } from '../../hooks/useTooltipTrigger';

import './ContextMenu.scss';

export interface ContextMenuItem {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** The choice already in force, for a menu that picks one of a set. */
  current?: boolean;
  onSelect: () => void;
}

export interface ContextMenuCheckbox {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  checked: boolean;
  /** Flipped in place: the menu stays open, so a run of boxes is set in one visit. */
  onToggle: (checked: boolean) => void;
}

export type ContextMenuEntry =
  | ContextMenuItem
  | ContextMenuCheckbox
  | { id: string; separator: true };

export interface ContextMenuProps {
  /** Position within the menu's containing block, in pixels. */
  x: number;
  y: number;
  /** Drawn as the menu's header strip and used as its accessible name. */
  label: string;
  entries: readonly ContextMenuEntry[];
  /**
   * The element the menu was opened from, if any.
   *
   * A press on it does not close the menu here — that button toggles the menu
   * itself, and closing on the way down would leave it reopening on the click.
   */
  anchor?: RefObject<HTMLElement>;
  onClose: () => void;
}

function isSeparator(entry: ContextMenuEntry): entry is { id: string; separator: true } {
  return 'separator' in entry;
}

function isCheckbox(entry: ContextMenuEntry): entry is ContextMenuCheckbox {
  return 'checked' in entry;
}

/**
 * A pointer-anchored menu.
 *
 * Sized and placed by the caller, but it clamps itself into the containing
 * block after mounting: a menu opened near the right or bottom edge would
 * otherwise run off the viewport, and the entries at the end are the ones a
 * user reaches for last.
 */
export function ContextMenu({ x, y, label, entries, anchor, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

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
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.current?.contains(target)) return;
      onClose();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchor, onClose]);

  return (
    <div
      className="context-menu"
      role="menu"
      aria-labelledby={titleId}
      ref={ref}
      tabIndex={-1}
      style={{ left: x, top: y }}
    >
      <div className="context-menu__title" id={titleId}>
        {label}
      </div>
      {entries.map((entry) => {
        if (isSeparator(entry)) return <hr key={entry.id} className="context-menu__rule" />;
        if (isCheckbox(entry)) return <ContextMenuCheck key={entry.id} item={entry} />;
        return <ContextMenuButton key={entry.id} item={entry} onClose={onClose} />;
      })}
    </div>
  );
}

function ContextMenuCheck({ item }: { item: ContextMenuCheckbox }) {
  const tooltip = useTooltipTrigger(item.hint);
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      className="context-menu__item context-menu__item--check"
      aria-checked={item.checked}
      aria-disabled={item.disabled || undefined}
      onClick={item.disabled ? undefined : () => item.onToggle(!item.checked)}
      {...tooltip}
    >
      <span className="context-menu__box" aria-hidden="true">
        {item.checked ? '×' : ''}
      </span>
      {item.label}
    </button>
  );
}

function ContextMenuButton({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const tooltip = useTooltipTrigger(item.hint);
  return (
    <button
      type="button"
      role="menuitem"
      className={`context-menu__item${item.current ? ' context-menu__item--current' : ''}`}
      // Marked the way the outliner marks the active row, rather than with a
      // glyph in the label: one reading for "this is the one you are on".
      aria-current={item.current ? 'true' : undefined}
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
