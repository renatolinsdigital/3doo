# State management

Zustand, five slices, one store.

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
    ...createPreferencesSlice(...args),
  })),
);
```

## The slices

| Slice | Holds |
| --- | --- |
| `scene` | Objects, imported assets, active/selected ids, cursor, project name, `meshVersion`, undo flags, status, last operator |
| `tool` | Editor mode, select mode, active tool, pivot, snapping, proportional editing, modal transform |
| `viewport` | Shading, overlays, camera settings, navigation preset, framing requests |
| `ui` | Toasts, open dialog, export options, merge preview |
| `preferences` | Tooltips, selection line width and colour, the fields persisted to localStorage |

Splitting into files is organisation. What actually prevents wasted renders is
**selecting narrowly at the call site**:

```tsx
// Good: re-renders only when the shading mode changes.
const shading = useEditorStore((state) => state.shading);

// Bad: re-renders on every store update.
const { shading } = useEditorStore();
```

## User preferences

Preferences are the settings that belong to the **person**, not the project:
tooltips on or off, how thick and what colour the selection outline is. They are
deliberately not part of a `.3doo` file: opening one someone sent you must
not repaint your viewport.

They live in `slices/preferences.ts` and persist to a single localStorage key:

```
3doo:preferences → {"tooltipsEnabled":true,"selectionLineWidth":2.0,"selectionLineColor":"#e5342a"}
```

One key holding one JSON object, rather than a key per setting. That is what
makes export and import a one-liner, and what stops a half-written settings
change from leaving the app in a state no version ever shipped.

The fields sit **flat on the store**, not nested under a `preferences` object, so
a component still selects one value and re-renders on one value:

```ts
const width = useEditorStore((state) => state.selectionLineWidth);
```

`currentPreferences()` gathers just those fields back up when the whole set is
needed, which is writing to storage and the export button.

### Every write goes through `coercePreferences`

Storage read, `setPreferences`, reset and import all funnel through the same
validator:

```ts
setPreferences: (patch) => apply(coercePreferences({ ...get().currentPreferences(), ...patch })),
```

Each field falls back to its own default independently, so a hand-edited blob or
a file from an older build cannot cost the user the rest of their settings, and a
width outside the slider's range cannot reach the renderer as a hairline or a
slab. Storage access is wrapped in `try`/`catch` throughout, because private
browsing throws on `localStorage` rather than returning `null`; a blocked read
means preferences do not persist, never that the editor refuses to start.

### Import and export

The preferences dialog writes `currentPreferences()` out with the same
`downloadText` / `pickTextFile` pair the project files use, so a settings file is
just JSON the user can carry to another browser.

Each of those takes a `FileKind` (`.pref` here, `.3doo` for projects,
`.obj` for meshes), which is both what the picker filters on and what the
selection is checked against afterwards. `accept` only filters the dialog; every
browser offers a route around it, and one that does not recognise a compound
suffix may not filter on it at all. Checking the name again on the way back is
what turns "unexpected token" into a sentence naming the extension expected.

Validation lives in the store, presentation in the dialog:
`importPreferences(text)` throws with a message worth showing, and the dialog
turns it into a toast. A file with none of the known keys is rejected rather than
silently applied as "all defaults", which is what stops dropping the wrong JSON
in from quietly wiping your settings.

## `meshVersion`, and why it exists

Meshes are mutated **in place**. `extrudeFaces(mesh, faces)` rewrites the same
`BMesh` instance rather than returning a new one.

That is the right call for the kernel, since rebuilding a half-edge graph immutably on
every drag frame would be slow and would invalidate every element reference an
operation is holding, but it means Zustand has no new reference to compare, so
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
step: an inverse for bevel-with-caps is a project of its own. Serializing the
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
restores. The stack is capped by the UNDO STEPS preference, 50 entries by
default and anywhere from 10 to 100, so memory stays bounded.

The `History` instance lives at module scope, not in the store. It is not render
state. Only `canUndo`, `canRedo` and the label of each step are mirrored into
the store, because those drive the buttons and the history dialog.

Cost: one `serializeMesh` per operation. That is the accepted trade for
correctness; per-operation inverse commands would be the way past it, and are
not built.

## One serialization format, four jobs

`serializeProject` / `serializeMesh` back all of:

- Save and load project files
- Undo snapshots
- Autosave's numbered copies, which are `.3doo` files like any other
- The clipboard path for `cloneMesh`

Because `cloneMesh` is `deserializeMesh(serializeMesh(mesh))`, any bug in the
format is caught by the operation tests, not just the file tests.

## Assets sit beside the objects, not inside them

An imported image is held once in `state.assets`, keyed by id, and an object
that draws one carries `image: { assetId }`. Undo replays the object list, so a
picture stored on the object would be copied into every history step: fifty
steps of a scene holding a 4MB photograph is 200MB of history. Keeping it out
of the replay also means an image object can be deleted and undone with its
bytes still loaded.

The bytes themselves never enter a history step. They live in the store, and
are inlined as base64 only when a `.3doo` is written. See [saving.md](saving.md).

## Store actions are the only mutation path

Components never mutate scene objects directly. Even the viewport, which is
imperative, calls store actions (`setObjectTransform`, `touchMesh`,
`recordHistory`) rather than writing state. That keeps undo correct: there is one
place that records history, and it is the same place that mutates.
