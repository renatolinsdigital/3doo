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
- Assets sit in `state.assets` by id, never inside an object, so history
  never copies image bytes.
- Ids carry a per-page-load stamp. Counters restart on reload; without the
  stamp an added object took an opened file's id and one of them vanished.
- Preferences sit flat on the store and every write goes through
  `coercePreferences`; storage access is wrapped, since private browsing
  throws.

## Traps

- Switching select mode must not flush again: it once invented selections
  (a cylinder's caps selecting the whole cylinder).
- Linked duplicates share one mesh instance; the link is saved as an id and
  must survive save and undo. Origin moves refuse a shared mesh.

## Tests

`resetScene()` in `beforeEach`. Wrap a store update made while a component is
mounted in `act`. Undo restores through the project format, so test undo
across it, not just the action.
