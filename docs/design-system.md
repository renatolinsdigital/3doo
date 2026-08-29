# Design system

Brutalist: hard corners, heavy borders, offset shadows, exposed structure. Loud
and honest, never a puzzle.

## Rules

- `border-radius: 0` everywhere. No exceptions: the reset enforces it globally.
- 2px to 3px solid black borders.
- Offset drop shadows, never blurred.
- No gradients, no glassmorphism, no soft states.
- Uppercase monospace labels, visible dividers.
- Buttons shift by the shadow offset when pressed so they meet their own shadow.
- Panels look bolted to the screen, not floating above it.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `--void` | `#0B0B0B` | Borders, text on light, panel outlines |
| `--bone` | `#F4F1EA` | Panel backgrounds, primary text on dark |
| `--red` | `#E5342A` | Primary actions, active tool, selection |
| `--oxblood` | `#7B1113` | Pressed states, headers, status strip |
| `--rust` | `#B8452F` | Secondary accents, hover |
| `--ash` | `#1A1918` | Viewport background |
| `--grid` | `#3A2A28` | Viewport grid lines |
| `--amber` | `#F2A03D` | Warnings, active axis, 3D cursor |
| `--cyan` | `#3DE0D0` | Focus rings, gizmo axis contrast |

Tokens are **CSS custom properties**, not Sass variables, because the viewport
reads the same palette at runtime (`VIEWPORT_COLORS` in `src/bridge/materials.ts`
mirrors them for Three.js). Sass provides organisation and mixins on top.

## Structure

```text
/src/global-styles
  theme.scss              tokens
  reset.scss              modern reset + the global border-radius: 0
  helpers.scss            mixins
  typography.scss         utility classes
  animations.scss         keyframes + prefers-reduced-motion
  responsive-mixins.scss  breakpoints
  index.scss              wires it together
```

Component styles are **colocated**: every component folder holds its `.tsx`,
`.scss` and test. Only the parent `components/index.ts` re-exports.

## Mixins

Components consume these rather than repeating border and shadow declarations:

```scss
@include brutal-border;      // 3px solid void, radius 0
@include brutal-shadow;      // 4px 4px 0 void, no blur
@include brutal-press;       // translate to meet the shadow on :active
@include brutal-focus;       // 3px cyan outline on :focus-visible
@include label-text;         // uppercase mono, wide tracking
@include display-text;       // Archivo Black, wide tracking
@include panel-header;       // oxblood bar with a hard divider
@include active-indicator;   // filled bar on the leading edge
```

## Typography

- **Archivo Black** for panel headers and display text.
- **JetBrains Mono** for labels, values and every numeric field.

One weight per role, wide tracking on headers, tabular numerals on values so
digits do not jitter as they change.

## Usability guardrails

Brutalism has to stay usable. These are requirements, not preferences:

- **Hit targets ≥ 40px** (`--hit-target`).
- **WCAG AA contrast** maintained across every combination in use.
- **Active state through at least two channels.** Never colour alone: the active
  tool gets a fill *and* a filled indicator bar; the active segment gets a fill
  *and* an inset underline; snapping state is spelled out as text
  (`SNAP VERTEX` / `SNAP OFF`), not just tinted.
- **Visible keyboard focus** everywhere, via `brutal-focus`. The `Toggle`
  component hides its input for styling, so the focus ring is moved onto the
  visible box.
- **A persistent hint line** in the status strip during modal operations.
- **No animation that obscures a state change.** Motion is limited to toast and
  modal entrances, and `prefers-reduced-motion` disables even those.

## Layout

```text
┌─────────────────────────────────────────────────────────────┐
│                          TOP BAR                            │
├──────┬──────────┬───────────────────────────┬───────────────┤
│      │          │                           │   OUTLINER    │
│ TOOL │  ADD /   │         VIEWPORT          ├───────────────┤
│ RAIL │  OPS     │                           │  PROPERTIES   │
│      │          │                           ├───────────────┤
│      │          │                           │  MODIFIERS    │
├──────┴──────────┴───────────────────────────┴───────────────┤
│                        STATUS BAR                           │
└─────────────────────────────────────────────────────────────┘
```

The viewport bleeds edge to edge behind the panels while keeping a hard 3px
frame. The status strip is oxblood and carries counts, the active operation,
modal hints and snap state.

At tablet width the left tool panel collapses; at mobile width the right column
collapses too, leaving the rail and viewport.

## Adding a component

1. Create `src/shared/components/Thing/` with `Thing.tsx`, `Thing.scss`,
   `Thing.test.tsx`. No `index.ts` inside the folder.
2. Style with the mixins above; do not hardcode colours or spacing.
3. Export it from `src/shared/components/index.ts`.
4. Shared components are presentation-only: no store access, no business logic.
   Anything domain-aware belongs in `src/domain/components/`.
