import { ModuleSwitcher } from '@app/ModuleSwitcher/ModuleSwitcher';
import { navigate } from '@app/router';
import { Button } from '@shared/components';

import './HomeModule.scss';

const CAPABILITIES = [
  {
    title: 'A REAL MESH KERNEL',
    body: 'A half-edge BMesh in pure TypeScript, with actual topology between vertices, edges and faces. That is what lets extrude, bevel, loop cut and dissolve behave the way they do on the desktop.',
  },
  {
    title: 'MODELLING OPERATIONS',
    body: 'Extrude, inset, bevel with segments, loop cut, Catmull-Clark subdivide, dissolve, fill, bridge, triangulate and tris-to-quads — on selections you make per vertex, edge or face.',
  },
  {
    title: 'NON-DESTRUCTIVE MODIFIERS',
    body: 'Mirror, array, solidify, weld and subdivision, reorderable and applied only when you say so. The stack evaluates for display and leaves the mesh you are editing alone.',
  },
  {
    title: 'GAME-READY EXPORT',
    body: 'OBJ with a matching MTL, or ASCII FBX 7.4, with axis and unit presets for Unity, Unreal, Blender and Maya. Projects save as JSON and autosave to IndexedDB.',
  },
];

export function HomeModule() {
  return (
    <div className="home">
      <header className="home__bar">
        <ModuleSwitcher />
      </header>

      <main className="home__main">
        <section className="home__hero">
          <p className="home__eyebrow">LIGHTWEIGHT 3D EDITOR</p>
          <h1 className="home__title">
            REAL MODELING
            <br />
            IN THE BROWSER
          </h1>
          <p className="home__lede">
            3DOO brings desktop modelling workflows to a browser tab. No install, no plugin, no
            account — open it and start building.
          </p>
          <div className="home__actions">
            <Button label="OPEN MODELING" variant="primary" onClick={() => navigate('/modeling')} />
            <Button label="READ THE DOCS" onClick={() => navigate('/docs')} />
          </div>
        </section>

        <section className="home__grid" aria-label="What 3DOO does">
          {CAPABILITIES.map((capability) => (
            <article key={capability.title} className="home__card">
              <h2 className="home__card-title">{capability.title}</h2>
              <p className="home__card-body">{capability.body}</p>
            </article>
          ))}
        </section>

        <section className="home__next">
          <h2 className="home__next-title">MODELING IS THE FIRST MODULE</h2>
          <p className="home__next-body">
            The editor is split into modules, switched from the plate in the top-left corner.
            Modeling is the one that ships today; sculpting is the next one being built. The docs
            module explains everything the current one can do.
          </p>
        </section>
      </main>

      <footer className="home__footer">
        <span>3DOO</span>
        <span>
          Developed by{' '}
          <a
            className="home__credit-link"
            href="https://www.linkedin.com/in/renatolinsdigital/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Renato Lins
          </a>
        </span>
      </footer>
    </div>
  );
}
