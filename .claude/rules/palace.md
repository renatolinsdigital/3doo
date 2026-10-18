# Palace

Loaded on every session (no `paths` frontmatter). It is the map: each room
below loads itself, through its own `paths` frontmatter, the moment a file in
its area is read, so only this page is paid for up front. How it all works,
for people: `docs/ai-memory.md`.

| Room | Loads for | Holds |
| --- | --- | --- |
| `room-kernel.md` | `src/kernel` | BMesh invariants, adding an operator, the fold limit, hot spots |
| `room-store.md` | `src/store` | Slices, `meshVersion`, undo, ids, the one mutation path |
| `room-bridge.md` | `src/bridge` | Marks against surfaces: lifts, occlusion, the far-side cull |
| `room-viewport.md` | `src/viewport` | The gizmo's rules, the camera's planes, the jsdom harness |
| `room-ui.md` | `src/domain`, `src/shared`, `src/app`, `src/modules` | Text rules, keymap, panels, component tests |
| `room-saving.md` | autosave, project files | No copy in the browser, `dirty`, the data-loss history |
| `room-scripting.md` | scripting, automation, `mcp/`, `aie2e/` | Checked options, transactions, adding a tool, the aie2e agents |
| `room-gpu.md` | `gpu/` | The real-GPU check, how it judges, what it cannot see |

## Where a task starts

Open these first and follow the code from there; do not survey the tree.

| Task | Files |
| --- | --- |
| Modelling operation | `src/kernel/ops/`, `commands/operators.ts`, `OPERATOR_SPECS`, a panel (`OperationsPanel`, `LoopOperationsPanel`, `TopologyPanel`), `keymap.ts` |
| Modifier | `src/kernel/modifiers/`, `addModifier` in `scene.ts`, `ModifierStack`, `MODIFIER_FIELDS` |
| Primitive | `src/kernel/primitives/index.ts`, `AddPanel` |
| Key binding | `DEFAULT_KEYMAP` in `keymap.ts`, `useKeymap.ts`, `docs/keymap.md` |
| Preference | `store/types.ts`, `coercePreferences` in `preferences.ts`, `PreferencesDialog` |
| Mark drawn wrong | `materials.ts`, `ObjectView.ts`, `meshBuffers.ts`, then `gpu/` |
| Gizmo, camera, picking | `Viewport.ts` by section, `CameraController.ts`, `picking.ts` |
| Save, open, autosave | `src/domain/services/autosave.ts`, `download.ts`, `useAutosave.ts`, `useProjectFiles.ts`, `src/kernel/io/project.ts` |
| Import, export | `src/kernel/io/obj.ts`, `fbx.ts`, `ExportDialog`, `useProjectFiles.ts` |
| Script API | `src/domain/scripting/api.ts`, `reference.ts`, `runScript.ts`, `sceneScript.ts` |
| MCP tool | `src/app/automation/`, `mcp/tools.ts`, `mcp/engine.ts`, `src/domain/mcp/guide.ts` |
| AI end to end run | `aie2e/run.ts`, `aie2e/rubric.ts`, the agents in `.claude/agents/`, `docs/how_aie2e_agents_work.md` |

Every user-facing feature also gets its entry in `src/modules/docs/content.ts`.

## Say which rooms you enter

The user always knows which rooms a task is in. Say it in chat, every task:

- **At the start**, one line naming the rooms the task will enter, picked
  from the two tables above: `Rooms: kernel, store`. A task that touches no
  room's area says `Rooms: none`.
- **When a read opens a room** that line did not name (its text arrives
  after the read), say so before the next step: `Entering room: viewport`.
- **The final reply** names the rooms the task actually entered, so a room
  that was planned but never opened, or one opened by surprise, shows.

## Reading the big files

Never read these whole: grep the symbol, then read a hundred lines round it.

- `Viewport.ts` (5,500 lines) is cut into sections marked `// ---- name`:
  setup, scene sync, gizmo, pointer, touch, knife, framing, lifecycle (the
  render loop, the camera planes and `dispose` are in lifecycle).
- `src/store/slices/scene.ts` (3,000): the `SceneSlice` interface documents
  every action, then `createSceneSlice` implements it. `grep -n` an action's
  name finds both. Selectors such as `activeObject` and `evaluatedMesh` close
  the file.
- `content.ts` (1,400): `DOCS_SECTIONS`, one entry per section, each with an
  `id`. The scripting tables are generated from `reference.ts`.
- Over a thousand lines too: `boolean.ts`, `src/domain/scripting/api.ts`,
  `quadify.ts`, `materials.ts`, `reference.ts`, `subdivide.ts`, `fbx.ts`,
  `mcp/tools.ts`, `knife.ts`, `ObjectView.ts`, `picking.ts`, `meshBuffers.ts`.

## Shared by every room

- Layers point inward: app, modules, domain, store, kernel. The kernel imports
  no React, three or DOM. Map and arrows: `docs/architecture.md`.
- Store actions are the only way anything changes the scene, the viewport
  included. Geometry is mutated in place and announced by `meshVersion`.
- `npm test` (all, jsdom), `npm run test:kernel` (fastest), `npm run test:gpu`
  (real GPU, needs Chrome, not part of `npm test`), `npm run lint`,
  `npm run typecheck`.
- Every fix ships with a regression test, red first (`regression-tests.md`).
  Existing regression tests carry a comment saying what "used to" happen:
  grep for it before changing a hot file.

## Keeping it true

When a fix, a trap or an invariant is learned, add one line to the room it
belongs to in the same change. A line that turns out wrong is deleted, not
left. Rooms hold what reading the code would not tell quickly; anything the
code or a doc already says plainly stays out. `src/tests/palace.test.ts`
fails when a room names a file or an identifier the code no longer has.
