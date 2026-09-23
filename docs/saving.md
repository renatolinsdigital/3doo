# Saving

Where a project lives, what holds it, and how the copy in the browser becomes a
file you can send to someone.

## Two copies, one shape

There are exactly two places a project exists, and they hold the same thing:

| Copy | Lives in | Written by | Survives |
| --- | --- | --- | --- |
| The autosave | This browser, on this machine | The editor, on a timer | A closed tab, a crash, a reboot |
| The file | Wherever you put it | You, with Ctrl+S | Anything, including a different machine |

Both are a `ProjectDocument`: the same JSON structure, built by the same
`serializeProject` in the kernel. Objects, meshes, transforms, materials,
modifiers, groups, the 3D cursor and which panels were folded are identical in
both, so the copy in the browser maps onto a `.3doo` with no conversion step
and no fields that only one of them understands.

Two things sit outside that document, and they are where the copies differ:

| | The autosave | The file |
| --- | --- | --- |
| Imported images | In OPFS, beside the record | Base64 inside the JSON |
| The undo timeline | In the record | Not there at all |

Images are the next section. The timeline is further down, under [what the file
leaves out](#what-the-file-leaves-out).

## The three stores, and why there are three

```text
localStorage ──► preferences          small, synchronous, yours not the project's
IndexedDB    ──► the project document structured, rewritten whole on every autosave
OPFS         ──► imported images      binary, written once, read back as files
```

**Preferences** go in `localStorage`, under `3doo:preferences`. They are a few
hundred bytes, they are read once while the store module evaluates (so they have
to be synchronous), and they belong to you rather than to any project: opening a
scene someone sent you must not repaint your viewport. `src/store/slices/preferences.ts`.

**The project document** goes in IndexedDB, in database `3doo`, object store
`autosave`, under the single key `latest`. One record, replaced each time,
holding the document, the time it was written and the undo timeline as it stood.
IndexedDB rather than `localStorage` because a scene is megabytes rather than
kilobytes, and `localStorage` is both capped around 5MB and synchronous, which
would stall the tab mid-edit. `src/domain/services/autosave.ts`.

**Imported images** go in the Origin Private File System, in an `assets`
directory, one file per asset id. OPFS rather than a blob field in the IndexedDB
record, because that record is rewritten in full on every autosave: a scene with
three reference photographs beside it would copy those megabytes every tick to
record that one vertex moved. In OPFS an image is written once, when it is
imported, and read back as a `File`. `src/domain/services/assets.ts`.

All three are ordinary web storage: this origin, this browser profile, this
machine. Nothing is uploaded, nothing is shared between browsers, and clearing
site data takes all three together. That last point is why the file matters.

## Assets

An imported image is an asset: an id, the file's own name, its MIME type, its
pixel size, and its bytes. The scene holds them in one map, `state.assets`,
keyed by id, and an object that draws one carries `image: { assetId }` and
nothing else.

Keeping them beside the objects rather than inside them is what makes undo
affordable. Undo replays the object list from a snapshot, so an image stored on
the object would be copied into every history step: fifty steps of a scene with
a 4MB photograph in it is 200MB of history. Instead a step describes the scene
and the assets stay where they are, which also means deleting an image object
and undoing finds the bytes still loaded.

The document's asset list carries the description always and the bytes only
sometimes:

```jsonc
// in the .3doo on disk: self-contained
"assets": [{ "id": "asset-1", "name": "ref.png", "type": "image/png",
             "width": 1920, "height": 1080, "data": "iVBORw0KGgo..." }]

// in IndexedDB: the bytes are in OPFS under the same id
"assets": [{ "id": "asset-1", "name": "ref.png", "type": "image/png",
             "width": 1920, "height": 1080 }]
```

So the mapping between the two copies is one step in each direction:

- **browser to file**: `inlineAssets` reads each blob and base64-encodes it into
  `data`. That is the whole of what `saveProject` does beyond `stringifyProject`.
- **file to browser**: `hydrateAssets` decodes `data` back to a blob, or reads
  OPFS when there is no `data` (which is the recovery path). `openProject` then
  writes them into OPFS, so the project just opened is the one being autosaved
  from then on.

Base64 costs about a third on top of the original image, and buys a `.3doo` that
is one file: sending someone a project sends them the pictures in it.

## The autosave

`useAutosave`, mounted by `ModelingModule`, does two separate jobs.

**On mount** it decides what the editor opens on. If a record is in IndexedDB
with objects in it, that session is loaded, its images are pulled from OPFS
beside it, and a toast says how many objects came back and when they were saved.
If there is nothing to come back to, the editor opens on a cube, the way Blender
does, because an empty viewport gives you nothing to try a tool against. The
cube is an ordinary undoable add, so one Ctrl+Z gives the empty scene to anyone
who wants it.

The guard on this is module scope, not a ref, for two reasons. Walking to DOCS
and back remounts the hook, and an empty scene by then is one the user emptied
on purpose. And `StrictMode` mounts, unmounts and remounts in development, so a
per-mount guard let the first mount claim the read and the second find it
claimed, which left the tab with neither a session nor a cube.

**On a timer** it writes, every `autosaveInterval` seconds, but only when the
project has actually changed. A tab opened and left alone writes nothing at all,
and neither does one sitting on a scene that has already been written: there is
no reason to keep replacing a record with a copy of itself. The images are synced
in the same tick, which is also where an image whose object was deleted and left
deleted is finally dropped from OPFS. It waits until then because a delete is
undoable, and the next autosave is the first moment the scene is known to have
settled without it.

Both jobs stop when the AUTOSAVE preference is off. Nothing is written, no
session is offered back, and an import keeps its image in memory rather than
putting it in OPFS. Handing work back from a setting someone turned off is the
surprise the setting exists to prevent, so a tab in that state opens on the cube.

### The interval

30 seconds, 1, 2, 3 or 5 minutes, from a picker in preferences. A short list
rather than a free number: the difference between 47 and 50 seconds is nothing
anybody needs, and the trade is easy to state. Shorter costs less when a tab
dies; longer stops a heavy scene being serialised so often.

## What counts as a change

`state.dirty` says whether the project differs from what is stored, and it is
raised by a subscription in `useEditorStore` rather than by each action that
edits something. The alternative is the same line in thirty actions, and the one
place it gets forgotten is a change that silently never reaches the autosave.
That is exactly how renaming an object came to be left out of it: a rename does
not touch geometry, so it never bumped `meshVersion`, which was what the timer
used to test.

The subscription watches `meshVersion`, `objects`, `groups`, `projectName`,
`cursor` and `assets`. Every edit in the application replaces one of those by
reference, because panels select them and an in-place change would not
re-render. Geometry is the exception, being mutated in place, and `meshVersion`
is what says it moved.

Two things are deliberately left out. Selection is not a change worth writing,
and clicking around a scene is the whole of what somebody who "did nothing"
did. Which panels are folded is layout, not project. Edit-mode selection does
come through `meshVersion`, because in this kernel a vertex carries its own
selected flag.

The flag is lowered in five places: after the opening cube (the editor's doing,
not the user's), after a session is recovered (what is on screen is what is
stored), after a file is opened, after one is saved, and by the autosave itself.
The autosave lowers it *before* the write rather than after, so an edit made
while the write is in flight raises it again and is caught by the next tick
instead of being swallowed by this one.

A save lowers it only once the file is actually written: a dismissed dialog and
a name already taken both leave the work pending. It also writes the browser's
copy on the way past, so the file and the autosave stand at the same scene. Left
out, the browser's copy would still be at the last tick while the flag said
everything had reached it.

### The scene is in a file

`state.savedToFile` is the second flag, and it answers a different question:
not "has the browser's copy caught up?" but "is this exact scene sitting in a
`.3doo` on disk?" A save raises it, and so does an open, since the file the
scene came out of is still there. The same subscription that raises `dirty`
takes it away again, so the first edit after a save is enough.

The two are separate because the autosave lowers `dirty` on its own, every
tick, without anything having left the browser. FILE > NEW below is the one
place that needs the other answer.

One ordering trap is worth knowing about: zustand runs subscribers after the
`set` that triggered them, so an action that clears the flag inside the same
`set` that changes the scene will have it raised again on the way out. Clear it
in a second `set`, as `resetScene` does.

## What the file leaves out

The undo timeline is kept in the browser and stays out of the `.3doo`.

A file is a scene. Someone opening one wants the model, not the forty steps
whoever made it took to get there, and undoing into a scene they have never seen
is a worse answer than having nothing to undo. The autosave is the other case
entirely: it exists so a tab that died can be picked up where it left off, and
half of "where it left off" is being able to take back what you were in the
middle of.

So `ProjectDocument` has no timeline field at all, which is what makes this
hold without anything having to remember to strip it. The steps ride in the
IndexedDB record instead, beside the document rather than inside it:

```ts
interface AutosaveRecord {
  document: ProjectDocument; // this is what a .3doo holds
  savedAt: string;
  history?: HistorySnapshot; // this is what only the browser holds
}
```

`History.snapshot()` hands both halves over as plain data and `restore()`
takes them back, capped at the size preference as it is now rather than as it
was when the record was written. Opening a `.3doo` restores no steps, because
there are none in it to restore.

### The budget

Every history entry holds a whole copy of the scene, and the record is rewritten
in full on every tick. A 50 step timeline on a 100k-vertex scene is 5 million
vertices per write, which is not a thing to do every 30 seconds.

`storableHistory` caps what goes in at 300,000 vertices in total, counted
across the stored steps, and keeps the newest that fit. A light scene keeps its
whole timeline. A heavy one keeps the few steps somebody is actually about to
reach for. One heavier than the budget on its own stores no timeline, and the
scene alone is written, which is what the autosave was before any of this.

Undo is filled before redo: coming back with three steps to take back and none
to put forward is the useful half of a tight budget. Entries are dropped from
the old end only, never from the middle, since a timeline with a hole in it
would undo to the wrong scene.

## One project at a time

The autosave holds the project being worked on, and only that one. There is no
list of past sessions and no way back to one.

That is why FILE > NEW asks before it runs, one of the two confirmations in the
editor, the reload prompt below being the other. Undo cannot reach back past a
reset, and the reset also clears the browser's copy of the old project along
with its images. The dialog names the project and its object count, says whether
autosave is even on, and points at Ctrl+S for anyone who wanted to keep it.

It asks every time, because it clears that copy every time. The one exception is
a project already saved to a `.3doo` and untouched since, which is what
`savedToFile` says: the work is on disk, NEW costs nothing, and a confirmation
about losing nothing is one people learn to click straight past. That is how a
real warning gets missed later.

An autosave tick is not that exception. It has kept the work in this browser,
which is exactly the copy NEW is about to clear, so a scene the autosave has
caught up with is still one worth asking about.

## Reloading the page

A browser reload throws the tab away and builds it again from the autosave, so
everything since the last tick goes with it. The browser does not ask, and
`beforeunload` can only offer its own wording, so the keyboard routes into it
are caught instead: `reloadShortcut` in the keymap names them, and `useKeymap`
answers them before anything else in the handler, including the guard that
keeps shortcuts out of text fields. A refresh is a refresh whatever had focus.

There are two answers, because there are two kinds of key.

**F5, and the hard reloads,** meaning F5 with anything held down with it and
Ctrl+Shift+R, are a reload the user asked for. They open the RELOAD THE PAGE
dialog, which offers the `.3doo` first. Saving and reloading waits for the file
to be written before it reloads, so a dismissed picker leaves the dialog
standing rather than reloading over a save that never happened. Reloading
without saving goes straight to `location.reload()`, which comes back on the
autosave.

**Ctrl+R is the loop cut**, so it never reaches the browser at all. In edit mode
it falls through to the keymap and cuts a loop. In object mode there is no loop
to cut and nothing happens: it is a key the editor has taken, not a request to
leave, and answering it with a dialog about reloading would be answering a
question nobody asked.

The physical key counts alongside the character for the Ctrl+R pair. A layout
with another letter printed on that key still reloads on it, because the browser
reads the position.

None of this covers the reload button, Ctrl+W, or the address bar. No page can
intercept those, which is what the autosave is for.

## What to reach for

| To | Use |
| --- | --- |
| Keep something past this browser | Ctrl+S. It is the only copy that leaves |
| Send a project to someone | The `.3doo`. Images ride inside it |
| Come back to yesterday's work | Just open the editor, if autosave is on |
| Model on a machine that keeps nothing | Turn AUTOSAVE off and save files by hand |
