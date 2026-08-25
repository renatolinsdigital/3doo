import { useEffect } from 'react';

import { DocsModule } from '../modules/docs/DocsModule';
import { HomeModule } from '../modules/home/HomeModule';
import { ModelingModule } from '../modules/modeling/ModelingModule';

import { moduleForPath } from './modules';
import { usePathname } from './router';

/**
 * Application shell.
 *
 * One job: read the path and hand the screen to a module. Everything a module
 * needs — layout, shortcuts, autosave — belongs to that module, which is what
 * keeps the editor's keymap from firing while someone is reading the docs, and
 * what leaves room for sculpting to arrive as one more entry here.
 */
export function App() {
  const active = moduleForPath(usePathname());

  useEffect(() => {
    document.title = `${active.brand} — ${active.summary}`;
  }, [active]);

  if (active.id === 'modeling') return <ModelingModule />;
  if (active.id === 'docs') return <DocsModule />;
  return <HomeModule />;
}
