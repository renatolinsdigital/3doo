---
paths:
  - "src/domain/services/**/*.ts"
  - "src/domain/hooks/useAutosave*"
  - "src/domain/hooks/useProjectFiles*"
  - "src/kernel/io/project.ts"
---

# Room: saving

Where the worst bugs live: these lose work. Red first is not optional here.
Depth: `docs/saving.md`.

## How it works

- A project exists only as a `.3doo` on disk or in the open tab. The browser
  keeps preferences and the autosave folder handle (IndexedDB), never a copy
  of the project.
- Autosave is off by default; on, it writes numbered `.3doo` copies into a
  folder the user picked. Copies are counted from the folder, case-blind,
  since Windows is.
- Three questions, three answers: `dirty` (touched since stored), the
  fingerprint (actually different from what was stored), `savedToFile` (this
  exact scene is in its own file). Touched is not changed: undo, folding a
  folder and switching select mode all bump state without changing the
  scene.
- Files leave the undo history out. Images travel inside the `.3doo` as
  base64 and nowhere else.
- `loadProjectDocument` repairs duplicate ids from files written before ids
  were stamped.

## Bugs that came back, and their tests

- After OPEN, undo could step back into the project the file replaced.
- A new object reused an opened object's id and one of them vanished.
- An edit made while a write was in flight was swallowed; a failed write
  still cleared `dirty`.
- StrictMode mounts hooks twice in development, and the opening scene once
  arrived twice. `useAutosave.test.tsx` renders under StrictMode to hold it.

Tests: `useAutosave.test.tsx`, `useProjectFiles.test.tsx`,
`store/slices/scene.test.ts`.
