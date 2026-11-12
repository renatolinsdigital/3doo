import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { ModuleSwitcher } from '@app/ModuleSwitcher/ModuleSwitcher';
import { navigate } from '@app/router';
import { SiteFooter, ThemeToggle } from '@domain/components';
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
  { label: 'MESH OPERATIONS', value: '31', note: 'Edit-mode tools, plus booleans' },
  { label: 'MODIFIERS', value: '12', note: 'Stackable and non-destructive' },
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
    body: 'Twenty-eight operations, applied to whatever you select in vertex, edge or face mode. These eleven are the core.',
    tags: [
      'EXTRUDE',
      'INSET',
      'BEVEL',
      'LOOP CUT',
      'KNIFE',
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
      'BEND',
      'TWIST',
      'LATTICE',
      'WELD',
      'LOOP SUBDIVIDE',
      'SUBDIVISION SURFACE',
      'QUADIFY',
      'TRIANGULATE',
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

const REEL_ID = 'KBKQk15FBj0';
const REEL_HOST = 'https://www.youtube-nocookie.com';

// The player starts muted because YouTube only autoplays reliably that way.
// Every click lands on the button laid over it, never on the player, so
// nothing can open YouTube or pause the reel. There is no loop parameter: the
// reel seeks back to the start itself, so it knows when a restart happens and
// can cover it, and the player never reaches its end screen.
const reelSource = () =>
  `${REEL_HOST}/embed/${REEL_ID}?${new URLSearchParams({
    autoplay: '1',
    mute: '1',
    controls: '0',
    disablekb: '1',
    fs: '0',
    iv_load_policy: '3',
    playsinline: '1',
    rel: '0',
    enablejsapi: '1',
    origin: window.location.origin,
  })}`;

const REEL_POSTER = `https://i.ytimg.com/vi/${REEL_ID}/maxresdefault.jpg`;
// YouTube lays its title, channel and buttons over the first seconds after
// every start and every seek, whatever the embed asks. The player is shown only
// once the reel is past them, so the poster covers each start and each loop.
// The fallback shows it anyway if the player never reports its time.
const REVEAL_AFTER_S = 3.5;
const REVEAL_FALLBACK_MS = 10_000;
const PLAYER_ENDED = 0;

const hasUserActivation = () => navigator.userActivation?.hasBeenActive ?? false;

function DemoReel() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const chosenRef = useRef(false);
  const [source] = useState(reelSource);
  const [muted, setMuted] = useState(() => !hasUserActivation());
  const [revealed, setRevealed] = useState(false);
  const mutedRef = useRef(muted);

  const post = useCallback(
    (message: object) =>
      frameRef.current?.contentWindow?.postMessage(JSON.stringify(message), REEL_HOST),
    [],
  );
  const applySound = useCallback(() => {
    for (const func of [mutedRef.current ? 'mute' : 'unMute', 'playVideo']) {
      post({ event: 'command', func, args: [] });
    }
  }, [post]);
  const setSound = useCallback(
    (nextMuted: boolean) => {
      mutedRef.current = nextMuted;
      setMuted(nextMuted);
      applySound();
    },
    [applySound],
  );

  useEffect(() => {
    let reported = false;
    const restart = () => {
      setRevealed(false);
      post({ event: 'command', func: 'seekTo', args: [0, true] });
      post({ event: 'command', func: 'playVideo', args: [] });
    };
    // Commands sent before the player is ready are dropped, so the sound is
    // applied again once it says it is.
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      let data: {
        event?: string;
        info?: { currentTime?: number; playerState?: number };
      };
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (data.event === 'onReady') applySound();
      const { currentTime, playerState } = data.info ?? {};
      if (currentTime !== undefined) {
        reported = true;
        setRevealed(currentTime >= REVEAL_AFTER_S);
      }
      if (playerState === PLAYER_ENDED) restart();
    };
    window.addEventListener('message', onMessage);
    const fallback = window.setTimeout(() => {
      if (!reported) setRevealed(true);
    }, REVEAL_FALLBACK_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(fallback);
    };
  }, [applySound, post]);

  useEffect(() => {
    if (!mutedRef.current) return;
    // Browsers refuse sound until the visitor has touched the page, so the
    // sound comes on at the first click or key anywhere. A click on the reel
    // is left to its own handler, which would otherwise undo it straight away.
    const unmuteOnGesture = (event: Event) => {
      if (screenRef.current?.contains(event.target as Node)) return;
      stopListening();
      if (!chosenRef.current) setSound(false);
    };
    const stopListening = () => {
      document.removeEventListener('pointerdown', unmuteOnGesture);
      document.removeEventListener('keydown', unmuteOnGesture);
    };
    document.addEventListener('pointerdown', unmuteOnGesture);
    document.addEventListener('keydown', unmuteOnGesture);
    return stopListening;
  }, [setSound]);

  const onLoad = () => {
    post({ event: 'listening', id: 'reel', channel: 'widget' });
    applySound();
  };

  const toggleSound = () => {
    chosenRef.current = true;
    setSound(!mutedRef.current);
  };

  return (
    <section className="home__reel" aria-label="Demo reel">
      <div ref={screenRef} className="home__reel-screen">
        <img className="home__reel-poster" src={REEL_POSTER} alt="" />
        <iframe
          ref={frameRef}
          className={revealed ? 'home__reel-video home__reel-video--shown' : 'home__reel-video'}
          src={source}
          title="3DOO demo reel"
          allow="autoplay; encrypted-media; picture-in-picture"
          tabIndex={-1}
          onLoad={onLoad}
        />
        <button
          type="button"
          className="home__reel-hit"
          aria-label={muted ? 'Turn the sound on' : 'Turn the sound off'}
          onClick={toggleSound}
        >
          <span className="home__reel-sound">{muted ? <SoundOffIcon /> : <SoundOnIcon />}</span>
        </button>
      </div>
    </section>
  );
}

function SoundGlyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="home__reel-glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="reel-sound-icon"
    >
      <path d="M2 6h2.5L8 3v10l-3.5-3H2Z" />
      {children}
    </svg>
  );
}

function SoundOnIcon() {
  return (
    <SoundGlyph>
      <path d="M10.5 6a2.8 2.8 0 0 1 0 4M12.5 4a5.6 5.6 0 0 1 0 8" />
    </SoundGlyph>
  );
}

function SoundOffIcon() {
  return (
    <SoundGlyph>
      <path d="m10.5 6 4 4m0-4-4 4" />
    </SoundGlyph>
  );
}

export function HomeModule() {
  return (
    <div className="home">
      <header className="home__bar">
        <ModuleSwitcher />
        <div className="home__bar-end">
          <span className="home__version">v {version}</span>
          <ThemeToggle />
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
              It also ships an MCP server, so an AI assistant can use 3DOO as a tool: it builds and
              edits models while you watch.
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

          <DemoReel />

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
