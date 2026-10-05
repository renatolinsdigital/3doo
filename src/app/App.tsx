import { lazy, Suspense, useEffect } from 'react';

import { moduleForPath } from './modules';
import { usePathname } from './router';

// One chunk per module, so the page someone lands on is the only code they wait for.
const DocsModule = lazy(() =>
  import('../modules/docs/DocsModule').then((m) => ({ default: m.DocsModule })),
);
const HomeModule = lazy(() =>
  import('../modules/home/HomeModule').then((m) => ({ default: m.HomeModule })),
);
const ModelingModule = lazy(() =>
  import('../modules/modeling/ModelingModule').then((m) => ({ default: m.ModelingModule })),
);

/**
 * Application shell.
 *
 * One job: read the path and hand the screen to a module. Everything a module
 * needs (layout, shortcuts, autosave) belongs to that module, which is what
 * keeps the editor's keymap from firing while someone is reading the docs, and
 * what leaves room for sculpting to arrive as one more entry here.
 */
export function App() {
  const active = moduleForPath(usePathname());

  useEffect(() => {
    document.title = `${active.brand}: ${active.summary}`;
  }, [active]);

  return (
    <Suspense fallback={null}>
      {active.id === 'modeling' ? (
        <ModelingModule />
      ) : active.id === 'docs' ? (
        <DocsModule />
      ) : (
        <HomeModule />
      )}
    </Suspense>
  );
}
