export type ModuleId = 'home' | 'modeling' | 'docs';

/**
 * One area of the application, reachable from the brand switcher.
 *
 * Kept as data rather than a component map so the switcher, the router and the
 * document title all read the same list — and so adding the sculpting module
 * later is one entry plus one case in `App`.
 */
export interface AppModule {
  id: ModuleId;
  path: string;
  /** Shown in the switcher's dropdown. */
  label: string;
  /** What the brand plate reads while the module is open. */
  brand: string;
  /** One line under the label in the dropdown, and the document title suffix. */
  summary: string;
}

export const APP_MODULES: readonly AppModule[] = [
  {
    id: 'home',
    path: '/',
    label: 'HOME',
    brand: '3DOO',
    summary: 'What 3DOO is and where to start',
  },
  {
    id: 'modeling',
    path: '/modeling',
    label: 'MODELING',
    brand: '3DOO - MODELING',
    summary: 'Build and edit meshes, then export them',
  },
  {
    id: 'docs',
    path: '/docs',
    label: 'DOCS',
    brand: '3DOO - DOCS',
    summary: 'How every part of the editor works',
  },
];

const HOME_MODULE = APP_MODULES[0];

/**
 * The module a path belongs to, falling back to home.
 *
 * Matched on a segment boundary rather than a bare prefix, so a future
 * `/modelling-guide` cannot be mistaken for the modeling module.
 */
export function moduleForPath(pathname: string): AppModule {
  const match = APP_MODULES.find(
    (module) =>
      module.path !== '/' && (pathname === module.path || pathname.startsWith(`${module.path}/`)),
  );
  return match ?? HOME_MODULE;
}
