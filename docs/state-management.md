# State management

Zustand, four slices, one store.

## Why Zustand rather than Redux or Context

Two requirements drove the choice:

1. **Fine-grained subscriptions.** The properties panel must not re-render when
   the camera moves. Zustand selectors give that per-field.
2. **Non-React readers.** The Three.js viewport is not a component. It needs to
   read state directly and subscribe imperatively.
   `subscribeWithSelector` provides both.

```ts
export const useEditorStore = create<EditorStore>()(
  subscribeWithSelector((...args) => ({
    ...createSceneSlice(...args),
    ...createToolSlice(...args),
    ...createViewportSlice(...args),
    ...createUiSlice(...args),
  })),
);
```

## The slices

| Slice | Holds |
| --- | --- |
| `scene` | Objects, active/selected ids, cursor, project name, `meshVersion`, undo flags, status, last operator |
| `tool` | Editor mode, select mode, active tool, pivot, snapping, proportional editing, modal transform |
| `viewport` | Shading, overlays, camera settings, navigation preset, framing requests |
| `ui` | Toasts, open dialog, export options, merge preview |

Splitting into files is organisation. What actually prevents wasted renders is
**selecting narrowly at the call site**:

```tsx
// Good: re-renders only when the shading mode changes.
const shading = useEditorStore((state) => state.shading);

// Bad: re-renders on every store update.
const { shading } = useEditorStore();
```

## `meshVersion`, and why it exists

Meshes are mutated **in place**. `extrudeFaces(mesh, faces)` rewrites the same
`BMesh` instance rather than returning a new one.

That is the right call for the kernel — rebuilding a half-edge graph immutably on
every drag frame would be slow and would invalidate every element reference an
operation is holding — but it means Zustand has no new reference to compare, so
nothing would re-render.

`meshVersion` is a counter bumped by every mutation. Anything that depends on
geometry reads it:

```ts
useEditorStore(
  useShallow((state) => {
    void state.meshVersion;   // subscribe to geometry changes
    return computeStats(state.objects);
  }),
);
```

`useShallow` is required wherever a selector builds a fresh object, because the
default `Object.is` comparison would see a new reference every call and re-render
forever.

The viewport subscribes to the same counter imperatively:

```ts
useEditorStore.subscribe(
  (state) => state.meshVersion,
  () => this.syncScene(),
);
```

## Selection lives on the mesh

Element selection is stored as flags on the `Vert`, `Edge` and `Face` objects,
not in the store. That is where the kernel operators expect to find it, and it
keeps the two from drifting apart.

`mesh.flushSelection(mode)` propagates from the mode's primary element type to
the other two, so switching between vertex, edge and face modes never loses a
selection.

## Undo

History stores **whole-document snapshots**, not `do`/`undo` command pairs.

Structural operations rewrite topology in ways that are painful to invert step by
step — an inverse for bevel-with-caps is a project of its own. Serializing the
document is one well-tested code path that already exists for save/load, and it
is fast enough well past the scale this editor targets.

The rule is: **snapshot before mutating.**

```ts
exec: (name, params, label) => {
  get().recordHistory(label ?? name);   // capture the "before" state
  execOperator(context, name, params);  // then mutate
  set((state) => ({ meshVersion: state.meshVersion + 1 }));
}
```

Undo pops the past stack, pushes the *current* document onto the redo stack, and
restores. The stack is capped at 64 entries, so memory stays bounded.

The `History` instance lives at module scope, not in the store — it is not render
state. Only `canUndo` and `canRedo` are mirrored into the store, because those
drive button disabled states.

Cost: one `serializeMesh` per operation. That is the accepted trade for
correctness; per-operation inverse commands are listed in `TODO.txt`.

## One serialization format, four jobs

`serializeProject` / `serializeMesh` back all of:

- Save and load project files
- Undo snapshots
- Autosave to IndexedDB and crash recovery
- The clipboard path for `cloneMesh`

Because `cloneMesh` is `deserializeMesh(serializeMesh(mesh))`, any bug in the
format is caught by the operation tests, not just the file tests.

## Store actions are the only mutation path

Components never mutate scene objects directly. Even the viewport, which is
imperative, calls store actions (`setObjectTransform`, `touchMesh`,
`recordHistory`) rather than writing state. That keeps undo correct: there is one
place that records history, and it is the same place that mutates.
