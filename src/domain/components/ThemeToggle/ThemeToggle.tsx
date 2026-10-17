import type { ReactNode } from 'react';

import { IconButton } from '@shared/components';
import { useEditorStore } from '@store/index';

import './ThemeToggle.scss';

/**
 * The dark mode switch. It sits in the bar of every module, since the theme
 * belongs to the whole page rather than to the editor.
 */
export function ThemeToggle() {
  const dark = useEditorStore((state) => state.theme === 'dark');
  const setPreferences = useEditorStore((state) => state.setPreferences);

  // Named for what a click does, so the glyph is the mode it switches to.
  return (
    <IconButton
      label={dark ? 'LIGHT MODE' : 'DARK MODE'}
      icon={dark ? <SunIcon /> : <MoonIcon />}
      className="theme-toggle"
      hint={
        dark
          ? 'Light mode: light panels and pages again, with dark text and frames. Kept with your preferences'
          : 'Dark mode: dark panels and pages, with light text and frames. Kept with your preferences'
      }
      onClick={() => setPreferences({ theme: dark ? 'light' : 'dark' })}
    />
  );
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="theme-toggle__glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** A crescent: what the chrome turns to. */
function MoonIcon() {
  return (
    <Glyph>
      <path d="M14 8.53A6 6 0 1 1 7.47 2a4.67 4.67 0 0 0 6.53 6.53Z" />
    </Glyph>
  );
}

/** The sun and its rays: back to light. */
function SunIcon() {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
    </Glyph>
  );
}
