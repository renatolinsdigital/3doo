---
paths:
  - "src/domain/**/*.ts"
  - "src/domain/**/*.tsx"
  - "src/shared/**/*.ts"
  - "src/shared/**/*.tsx"
  - "src/app/**/*.ts"
  - "src/app/**/*.tsx"
  - "src/modules/**/*.ts"
  - "src/modules/**/*.tsx"
---

# Room: UI

Domain knows what the app is; shared only presents. Depth:
`docs/architecture.md`, `docs/design-system.md`, `docs/keymap.md`.

## Text

Every label, hint, toast, status line and the in-app docs
(`src/modules/docs/content.ts`) follow `writing-style.md`: no em or en
dashes, and no mention of Blender except as an export target. A status
string says what happened (`Extruded 1 face(s) by 1`), never `ok`.

`content.ts` is the most changed file in the repo (92 commits): features land
together with their docs entry.

## Structure

- `shared/` components take no store, except `ToastHost`. One folder per
  component with its `.tsx`, `.scss` and test; `index.ts` is the barrel.
- `useKeymap` and `useAutosave` mount in `ModelingModule`, not `App`, so keys
  do nothing on the docs page and the home page creates no WebGL context.
- Nothing in `domain` imports from `app`: `TopBar` gets the brand plate as a
  prop. The router is about thirty lines over `history`; no dependency.
- Select narrowly at the call site; a selector that builds an object needs
  `useShallow`.

## Keymap

Bindings live in `src/domain/keymap/keymap.ts`. A shifted punctuation key
never arrives as itself, so bind the physical key; camera keys answer on the
number row and the numpad alike; Meta counts as Ctrl. Ctrl+A and the reload
keys are taken from the browser on purpose.

## Controls

A disabled control stays hoverable and focusable so its hint can say why. On
touch a long press stands in for hover and right-click.

## Tests

Testing Library against the real component; `App.test.tsx` mounts the whole
shell with the viewport mocked. A store update made while mounted goes in
`act`.
