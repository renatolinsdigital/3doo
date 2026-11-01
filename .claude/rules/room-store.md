---
paths:
  - "src/store/**/*.ts"
---

# Room: store

Zustand with `subscribeWithSelector`, five slices: scene, tool, viewport, ui,
preferences. Depth: `docs/state-management.md`.

## Invariants

- Store actions are the only mutation path. The viewport calls them too
  (`setObjectTransform`, `touchMesh`, `recordHistory`).
- `meshVersion` is bumped by every mutation, `setObjectTransforms` included,
  so every gizmo drag tick resyncs the viewport. Anything reading geometry
  reads `meshVersion`; a selector building an object needs `useShallow`.
- The evaluated modifier stack is memoised on `meshVersion`. An edit that
  moves vertices without bumping it leaves the stack drawing the old shape.
- Undo stores whole-document snapshots: `recordHistory` before mutating.
  `History` lives at module scope; only its flags and labels are mirrored.
  `transact` makes a batch one step and rolls back on a throw.
- A refused or cancelled action must not drop a step it did not record
  (`discardHistory` once took the step underneath).
- Every selection change is a step through `recordSelection`, which records
  only when `selectionKey` moved: a no-op pick that recorded would also wipe
  redo. The document carries `selectedObjectIds`; `sceneFingerprint` leaves
  it out, as it does `activeObjectId`.
- An operation that splits, joins, cuts, deletes or reshapes ends with
  `announce(get())`, which raises its status as a success toast. `exec` does
  it for every operator outside `SELECTION_OPERATORS`. It is quiet inside
  `transact`, so a script raises one toast, not one per step. Adding objects
  stays quiet: the opening cube goes through `addPrimitive`.
- `resetScene` keeps the toasts on screen.
- Assets sit in `state.assets` by id, never inside an object, so history
  never copies image bytes.
- Ids carry a per-page-load stamp. Counters restart on reload; without the
  stamp an added object took an opened file's id and one of them vanished.
- Preferences sit flat on the store and every write goes through
  `coercePreferences`; storage access is wrapped, since private browsing
  throws. Each write stores the whole set, defaults included, so a changed
  default only reaches someone who never changed a preference, or presses RESET.

## Traps

- Switching select mode must not flush again: it once invented selections
  (a cylinder's caps selecting the whole cylinder).
- Linked duplicates share one mesh instance; the link is saved as an id and
  must survive save and undo. Origin moves refuse a shared mesh.

## Tests

`resetScene()` in `beforeEach`. It keeps the select mode, so a test that
switches it leaks into the next: set the mode a test relies on. Wrap a store
update made while a component is mounted in `act`. Undo restores through the
project format, so test undo across it, not just the action.
