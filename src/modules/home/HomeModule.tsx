import { ModuleSwitcher } from '@app/ModuleSwitcher/ModuleSwitcher';
import { navigate } from '@app/router';
import { SiteFooter } from '@domain/components';
import { Button } from '@shared/components';

import { version } from '../../../package.json';

import './HomeModule.scss';

const FACTS = [
  { label: 'INSTALL', value: 'NONE' },
  { label: 'PLUGIN', value: 'NONE' },
  { label: 'ACCOUNT', value: 'NONE' },
  { label: 'RUNS IN', value: 'A BROWSER TAB' },
  { label: 'WORKS WITH AI', value: 'ABSOLUTELY' },
];

const STATS = [
  { label: 'KERNEL', value: 'HALF-EDGE', note: 'Every element knows its neighbours' },
  { label: 'MESH OPERATIONS', value: '19', note: 'Edit-mode tools, plus booleans' },
  { label: 'MODIFIERS', value: '7', note: 'Stackable and non-destructive' },
  { label: 'IMPORT / EXPORT', value: 'OBJ · FBX', note: 'Both formats, both ways' },
  { label: 'ENGINE PRESETS', value: '4', note: 'Unity, Unreal, Blender, Maya' },
];

const CAPABILITIES = [
  {
    number: '01',
    badge: 'CORE',
    title: 'A REAL MESH KERNEL',
    body: 'A half-edge BMesh written in pure TypeScript. Vertices, edges and faces know their neighbours, so extrude, bevel, loop cut and dissolve behave exactly as they do on the desktop.',
    tags: ['HALF-EDGE', 'BMESH', 'TYPESCRIPT'],
  },
  {
    number: '02',
    badge: 'EDIT',
    title: 'MODELING OPERATIONS',
    body: 'Nineteen operations, applied to whatever you select in vertex, edge or face mode. These ten are the core.',
    tags: [
      'EXTRUDE',
      'INSET',
      'BEVEL',
      'LOOP CUT',
      'SUBDIVIDE',
      'DISSOLVE',
      'FILL',
      'BRIDGE',
      'TRIANGULATE',
      'TRIS → QUADS',
    ],
  },
  {
    number: '03',
    badge: 'STACK',
    title: 'NON-DESTRUCTIVE MODIFIERS',
    body: 'Stack modifiers in any order. They change what you see, never the mesh you are editing, until you choose to apply them.',
    tags: [
      'MIRROR',
      'ARRAY',
      'SOLIDIFY',
      'WELD',
      'LOOP SUBDIVIDE',
      'SUBDIVISION SURFACE',
      'REMESH',
    ],
  },
  {
    number: '04',
    badge: 'SHIP',
    title: 'GAME-READY EXPORT',
    body: 'OBJ with a matching MTL, or binary FBX 7.4, with axis and unit presets per engine. Projects save as JSON, and autosave keeps numbered backups in a folder you choose.',
    tags: ['UNITY', 'UNREAL', 'BLENDER', 'MAYA'],
  },
];

const openModeling = () => navigate('/modeling');
const openDocs = () => navigate('/docs');

export function HomeModule() {
  return (
    <div className="home">
      <header className="home__bar">
        <ModuleSwitcher />
        <div className="home__bar-end">
          <span className="home__version">v {version}</span>
          <Button label="START MODELING" variant="primary" onClick={openModeling} />
        </div>
      </header>

      <div className="home__page">
        <main className="home__main">
          <section className="home__hero">
            <p className="home__badges">
              <span className="home__badge home__badge--solid">LIGHTWEIGHT 3D EDITOR</span>
              <span className="home__badge">MODELING MODULE · NOW LIVE</span>
            </p>
            <h1 className="home__title">
              REAL MODELING
              <br />
              IN THE BROWSER<span className="home__title-dot">.</span>
            </h1>
          </section>

          <section className="home__intro">
            <p className="home__lede">
              3DOO puts desktop-grade modeling in a browser tab: real topology, real mesh
              operations, real export. Open it and start building.
            </p>
            <p className="home__lede">
              It also ships an MCP server, so an AI assistant can use 3DOO as a tool: it builds
              and edits models while you watch.
            </p>
            <div className="home__actions">
              <Button
                className="home__cta home__cta--arrow"
                label="OPEN MODELING"
                variant="primary"
                onClick={openModeling}
              />
              <Button className="home__cta" label="READ THE DOCS" onClick={openDocs} />
            </div>
            <dl className="home__facts">
              {FACTS.map((fact) => (
                <div key={fact.label} className="home__fact">
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="home__reel" aria-label="Demo reel">
            <div className="home__reel-bar">
              <span className="home__reel-name">VIEWPORT: DEMO REEL</span>
              <span className="home__reel-format">GIF / MP4 / WEBM · 16:9</span>
            </div>
            <div className="home__reel-screen">
              <span className="home__reel-play" aria-hidden="true" />
              <p className="home__reel-title">DROP YOUR DEMO HERE</p>
              <p className="home__reel-spec">1920 × 1080 · LOOPING · MUTED · 10 TO 20 S</p>
              <span className="home__reel-caption home__reel-caption--start">
                PERSPECTIVE · FACE MODE
              </span>
              <span className="home__reel-caption home__reel-caption--end">00:00 / [0:15]</span>
            </div>
          </section>

          <dl className="home__stats">
            {STATS.map((stat) => (
              <div key={stat.label} className="home__stat">
                <dt>{stat.label}</dt>
                <dd>{stat.value}</dd>
                <dd className="home__stat-note">{stat.note}</dd>
              </div>
            ))}
          </dl>

          <section className="home__inside" aria-labelledby="home-inside-title">
            <div className="home__section-head">
              <h2 id="home-inside-title" className="home__section-title">
                WHAT&apos;S INSIDE
              </h2>
              <span className="home__section-note">§01 / FOUR PARTS, ONE TAB</span>
            </div>

            <div className="home__grid">
              {CAPABILITIES.map((capability) => (
                <article key={capability.number} className="home__card">
                  <div className="home__card-head">
                    <span className="home__card-number" aria-hidden="true">
                      {capability.number}
                    </span>
                    <span className="home__card-badge">{capability.badge}</span>
                  </div>
                  <h3 className="home__card-title">{capability.title}</h3>
                  <p className="home__card-body">{capability.body}</p>
                  <ul className="home__tags">
                    {capability.tags.map((tag) => (
                      <li key={tag} className="home__tag">
                        {tag}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>

          <section className="home__closer">
            <h2 className="home__closer-title">
              OPEN A TAB.
              <br />
              START BUILDING.
            </h2>
            <div className="home__actions">
              <Button
                className="home__cta home__cta--dark home__cta--arrow"
                label="OPEN MODELING"
                onClick={openModeling}
              />
              <Button className="home__cta" label="READ THE DOCS" onClick={openDocs} />
            </div>
          </section>
        </main>

        <SiteFooter className="home__footer" />
      </div>
    </div>
  );
}
