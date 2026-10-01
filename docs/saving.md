# Saving

Where a project lives, how it gets there, and what the browser keeps of it
(nothing).

## In short

- A project only ever exists as a `.3doo` file on disk, or in the open tab.
- The browser keeps your preferences and the autosave folder handle. It keeps
  no copy of the project.
- Closing or reloading a tab loses whatever is in no file.
- Autosave is off until you turn it on. Then it writes numbered copies into a
  folder you choose.

| To | Use |
| --- | --- |
| Keep something past this tab | Ctrl+S, or autosave's numbered copies |
| Send a project to someone | The `.3doo`. Its images travel inside it |
| Come back to yesterday's work | Ctrl+O on its file, or on its newest numbered copy |
| Go back to how it was an hour ago | Ctrl+O on the numbered copy from then |
| Model on a machine that keeps nothing | Leave AUTOSAVE off and save files by hand |

## Where a project lives

A project is kept in two kinds of place, and both are `.3doo` files:

| Copy | Lives in | Written by | Survives |
| --- | --- | --- | --- |
| The file | Wherever you put it | You, with Ctrl+S | Anything, including a move to another machine |
| The numbered copies | `3doo-auto-saves`, in a location you choose | The editor, on a timer, once autosave is on | Anything, including a move to another machine |

Both are the same thing written at different moments. `projectText` in
`services/assets.ts` builds the text, and SAVE and the autosave both call it.
The text is a `ProjectDocument`, the JSON structure that `serializeProject` in
the kernel builds. It holds:

- objects, meshes, transforms, materials and modifiers,
- groups and the 3D cursor,
- which panels were folded,
- the imported images, as base64.

Until something is written to a file, the scene exists only in the tab. That is
a deliberate trade: none of your work sits in browser storage where you cannot
see it, and the way back to it is always a file you can open, move or send.

## What the browser keeps

```text
localStorage ──► preferences               small, synchronous, yours not the project's
IndexedDB    ──► the autosave location     a folder handle, the one thing only it can hold
```

**Preferences** go in `localStorage`, under `3doo:preferences`
(`src/store/slices/preferences.ts`). They are stored there because:

- they are a few hundred bytes,
- they are read while the store module evaluates, so the read has to be
  synchronous,
- they belong to you, not to a project: opening a scene someone sent you must
  not repaint your viewport.

**The autosave location** goes in IndexedDB: database `3doo`, object store
`autosave`, key `location` (`src/domain/services/autosave.ts`). It is a
`FileSystemDirectoryHandle`. JSON cannot hold one, and IndexedDB is the only
storage a handle survives in. Keeping it means that after a restart the browser
only has to ask for permission again, not for the folder.

Earlier builds stored the project itself in that object store, under `latest`,
with the imported images in the Origin Private File System. `forgetBrowserCopy`
deletes both when the editor opens, so a browser that ran one of those builds
does not keep holding a project nothing reads.

## Images

An imported image is an **asset**: an id, the file's name, its MIME type, its
pixel size and its bytes. The scene holds all assets in one map,
`state.assets`, keyed by id. An object that draws one carries
`image: { assetId }` and nothing else.

Assets sit beside the objects, not inside them, so that undo stays affordable.
Undo replays the object list from a snapshot. An image stored on the object
would be copied into every history step: fifty steps of a scene with a 4MB
photograph is 200MB of history. With the bytes kept apart, a step describes the
scene and the assets stay where they are. It also means that deleting an image
object and undoing finds the bytes still loaded.

The document always carries the description of each asset, and carries the
bytes only in a file:

```jsonc
// in the .3doo on disk: self-contained
"assets": [{ "id": "asset-1", "name": "ref.png", "type": "image/png",
             "width": 1920, "height": 1080, "data": "iVBORw0KGgo..." }]

// in memory, and in every undo step: the bytes are in state.assets
"assets": [{ "id": "asset-1", "name": "ref.png", "type": "image/png",
             "width": 1920, "height": 1080 }]
```

One function converts in each direction:

- **Tab to file**: `inlineAssets` reads each blob and base64-encodes it into
  `data`. `projectText` is that plus `stringifyProject`, and it is the whole of
  what a save or a numbered copy writes.
- **File to tab**: `hydrateAssets` decodes `data` back to a blob. An asset that
  arrives without `data` comes back without bytes, so the object can say which
  picture is missing instead of silently drawing a blank plane.

Base64 adds about a third to the image's size. In return a `.3doo` is one file:
sending someone a project sends them its pictures too.

## Save and Save as

| Command | Does |
| --- | --- |
| SAVE AS (Ctrl+Shift+S) | Always asks where. Opens the browser's save dialog with the project name suggested, writes a new `.3doo`, and refuses to replace a file that is already there |
| SAVE (Ctrl+S) | Asks nothing. Writes the project straight back over its file |

### Which file SAVE writes to

SAVE writes over `state.projectFile`: the `FileSystemFileHandle` that the save
or open picker handed back.

- SAVE AS and OPEN set it. NEW clears it. A reload starts a fresh scene without
  one.
- An edit leaves it alone. After an edit the project still belongs to that
  file, even though the file no longer holds what is on screen. (Compare
  `savedToFile`, [below](#is-this-scene-in-its-own-file), which an edit does
  clear.)

SAVE only writes while the project name in the top bar matches the file's name:
`lamp` for `lamp.3doo`. A project renamed away from `lamp` is on its way to a
new file, and only SAVE AS, which offers the new name, can ask where that goes.
Typing the old name back makes SAVE write over `lamp.3doo` again. `saveTarget`
in `services/download.ts` is the rule, and both the menu entry and
`saveProject` ask it.

So the name follows the file:

- SAVE AS puts the name chosen in the dialog into the top bar, since it need
  not be the one the dialog suggested.
- OPEN puts the opened file's name there, not the name saved inside it, which a
  file renamed on disk no longer matches.
- Undo leaves the name alone. A rename records no step, so replaying an older
  step would otherwise take SAVE away without anyone typing anything.

### When SAVE cannot write

The SAVE menu entry is greyed out when there is nothing to write over, and its
hint says which reason applies:

- the project has no file yet,
- the name no longer matches the file,
- the browser cannot write back to files at all.

<kbd>Ctrl</kbd>+<kbd>S</kbd> behaves like SAVE, but falls through to SAVE AS in
the first two cases. A key cannot be greyed out, so a press that did nothing
would read as broken. The two prompts that offer a save before discarding work
(in front of NEW and OPEN, and in front of a reload) behave like Ctrl+S.

Only Chromium browsers hand out file handles, through their pickers. Elsewhere
OPEN reads through a file input, which gives the page a copy of the contents
and no way back to the file, and SAVE AS is a download the page cannot reach
once it lands. SAVE stays greyed out there, and its hint says why instead of
pointing at a SAVE AS that would not help.

A handle from the save picker can write straight away. One from the open picker
can only read, so the first SAVE after an OPEN makes the browser ask for write
permission. A refusal shows as a failed save with a toast that says so, not as
a dismissed dialog, because nothing else on screen would explain why the file
did not change.

## Opening and starting over

### The prompt in front of NEW and OPEN

FILE > NEW and FILE > OPEN both replace the scene on screen and every undo step
behind it, and undo cannot reach back across either. So both ask first, through
one dialog, `ReplaceProjectDialog`. It reads `dialog === 'newProject'` or
`'openProject'` to pick its wording and where to go next.

It offers three ways out: save and go on, go on anyway, or stay. Saving waits
for the file to be written before anything is discarded, so a dismissed picker
leaves the dialog standing instead of throwing the project away. With autosave
on, it also says where the numbered copies are (they stay, and FILE > OPEN
brings any of them back) and whether there are changes none of them has yet.

**No prompt when nothing would be lost.** When the project is saved to its own
`.3doo` and untouched since (`savedToFile`), NEW and OPEN just run. A prompt
about losing nothing teaches people to click straight past prompts, which is
how a real warning gets missed later. Ctrl+O goes through the same check: a
shortcut is a faster route to the action, not a way around what it costs.

An autosave tick does not count here. A numbered copy is a backup in a folder
of them, not the file the project belongs to, so a scene the autosave has
caught up with is still worth offering to save.

### The file leaves out the undo history

The undo timeline stays in the tab that made it. Someone opening a file wants
the model, not the forty steps its author took to get there, and undoing into a
scene they have never seen is worse than having nothing to undo. The numbered
copies leave it out too.

`ProjectDocument` has no timeline field at all, so nothing has to remember to
strip it. Opening a `.3doo` therefore restores no steps, and `openProject` also
calls `clearHistory()`: the steps behind the previous project are not steps
behind this one.

### Ids are stamped per page load

Objects, folders, materials and modifiers are found by id, and a file keeps the
ids it was saved with. The counters that make new ids restart at every page
load, so on a counter alone, the next object added after an OPEN could take the
id of one the file had just brought in. The viewport draws one mesh per id, so
the object already on screen would vanish under the new one.

To prevent that, every id carries a stamp of the page load that made it
(`object-mdr3k2x1-4`), so it cannot collide with one from a file saved in
another session. A file written before the stamp existed may hold two objects
under one id. `loadProjectDocument` repairs it on load by giving the second a
fresh id.

## The autosave

Autosave is off until you turn it on with the AUTOSAVE switch in PREFS. The
LOCATION row beside it chooses the folder (see
[the autosave location](#the-autosave-location)).

`useAutosave`, mounted by `ModelingModule`, does two separate jobs: one when
the editor opens, and one on a timer.

### When the editor opens

- **It opens the editor on a cube.** An empty viewport gives you nothing to try
  a tool on. The cube is an ordinary undoable add, so one Ctrl+Z empties the
  scene. No earlier session is restored, whatever the AUTOSAVE switch says: the
  numbered copies are files, and FILE > OPEN is the way back to one.
- **It reads the autosave location back,** so PREFS can name it (see
  [permission after a restart](#permission-after-a-restart)).
- **It clears what earlier builds left in the browser** (`forgetBrowserCopy`).

The guard against adding a second cube lives at module scope, not in a ref.
Walking to DOCS and back remounts the hook, and an empty scene by then is one
the user emptied on purpose.

### On each tick

Every `autosaveInterval` seconds the hook writes one new numbered `.3doo` into
the folder, and nothing anywhere else, but only when all three hold:

1. AUTOSAVE is on.
2. The location may be written to (`autosaveLocationReady`). While the browser
   waits for permission nothing is written and `dirty` stays raised, so the
   first tick after permission is granted writes what changed meanwhile.
3. The scene has changed since the last save, by SAVE or by the timer (see
   [what counts as a change](#what-counts-as-a-change)). A tab left alone writes
   nothing, so the folder does not fill with copies of the same scene.

**A write that fails** (a full disk, a sync client holding the file) raises a
warning toast in the browser's own words, and raises `dirty` again so the next
tick retries. The one exception: if a SAVE landed while the copy was in flight,
`dirty` stays down, because that file already holds what the copy could not.

### The disk in the status bar

A write that lands is shown by a small floppy disk turning once in the status
bar, at the right of the message slot. Nothing else announces it.

- **Why show anything:** an autosave that leaves no trace is one people do not
  trust, and the alternative is pressing Ctrl+S every few minutes against a
  copy that was already being kept.
- **Why no toast:** a message on every tick, about a write nobody asked for and
  nobody has to answer, is noise. Which copy is newest needs no message either:
  it is the highest number in the folder.
- **The animation:** one turn about its vertical axis over 2.5 seconds, at full
  strength for the middle three quarters so the fade is only the entrance and
  exit.
- **The colour:** bone, the colour of the bar's own text, not amber. Amber on
  this bar means a setting is in force, and the disk is an event, not a state.

Implementation details that keep it honest:

- It is driven by `state.autosaveToken`, a counter the hook bumps **after** a
  copy has landed. Not by `dirty`, which is lowered before the write goes out:
  that would draw a disk for a write still in flight, and again for one that
  failed.
- It is a counter, not a timestamp, so two writes a minute apart both restart
  the animation. The status bar compares it with the value it last saw, not
  with zero, so a bar that mounts mid-session (switched back on in PREFS, or
  back from DOCS) does not replay writes it never witnessed.
- The slot keeps its space while the disk is hidden, so the status message
  beside it does not shift on every tick.
- The disk is `aria-hidden`. It sits inside the message slot, a live region,
  and announcing it would interrupt whatever the editor was saying. The
  AUTOSAVE preference states the behaviour in words, and a failed write still
  raises its warning.
- Visibility comes from the class and the turn from the `save-spin` keyframes.
  That split lets the reduced-motion rule in `animations.scss` remove the turn
  without removing the disk: with reduced motion the disk shows face on, held
  still, for the same 2.5 seconds. `SAVE_SPIN_MS` and the keyframes are a pair:
  change one without the other and the disk is cut off mid-turn or left
  standing at the end.

### The interval

The PREFS picker offers 30 seconds, or 1, 2, 3, 5, 10 or 15 minutes, with 3
minutes as the default. A short list is easier than a free number: the
difference between seven minutes and eight matters to nobody. The trade is easy
to state. Shorter loses less when a tab dies. Longer leaves fewer copies in the
folder and serialises a heavy scene less often.

## The autosave location

The numbered copies go in a folder called `3doo-auto-saves`, inside a location
you choose. One folder serves every project.

### Choosing it

A page cannot reach a folder on disk until the user hands it one, through
`showDirectoryPicker`, and the picker only opens inside a click. There are two
ways in:

- The LOCATION row under the AUTOSAVE switch shows the chosen folder's name,
  with CHOOSE or CHANGE to run the picker (`chooseAutosaveLocation` in
  `useAutosave.ts`).
- Turning the switch on with no location yet runs the picker there and then
  (`turnAutosaveOn`). Dismissing it leaves autosave off.

The picker opens in Documents the first time and in the current location after
that. It asks to write (`mode: 'readwrite'`), which is the permission prompt the
user sees.

Chromium refuses the home folder, the Desktop, Documents and Downloads
themselves, but allows any folder inside them. Picking one of those shows
Chrome's own notice about system files, and giving up there reaches the page as
an ordinary dismissal. The PREFS hint says which folders to avoid.

`pickAutosaveLocation` in `autosave.ts` stores what comes back. Then
`autosaveFolderIn` finds the folder the copies go in:

- the location itself, when it is already called `3doo-auto-saves` (in any
  case, since a person typed it),
- otherwise a `3doo-auto-saves` folder made inside it.

The folder is made at once, so a location that cannot take it fails while the
user is still choosing. It is looked up again at every write, so one deleted
between two ticks is simply made again.

The row shows the result as `Projects/3doo-auto-saves`. That is only the chosen
folder's own name, because the browser never tells a page the full path to
anything. The root of a drive is the one special case. Chromium names it by its
separator alone (`\` for `D:\`, hiding the drive letter like the rest of the
path), so the row drops the separator and shows `/3doo-auto-saves` rather than
`\/3doo-auto-saves`.

### Browsers without a folder picker

Only Chromium browsers have `showDirectoryPicker`. Elsewhere `canPickFolder()`
is false and autosave has nowhere to write, so:

- the switch is greyed out, with a hint saying why,
- the LOCATION row is not shown,
- a preference that arrives switched on is turned off when the editor opens.

### What the copies are called

`autosaveStem` names the copies after the `.3doo` the project was saved as or
opened from: `lamp.3doo` gets `lamp_01.3doo`, `lamp_02.3doo` and so on.

- Before there is a file, it uses the project name from the top bar. That is
  `untitled` until someone types another, so an unnamed project writes
  `untitled_01.3doo`.
- A character Windows refuses in file names becomes an underscore.
- The name is read at the moment of writing, so a SAVE AS renames every copy
  after it.

`nextAutosaveName` counts from what is already in the folder, not from the
session: one past the highest number there for that name. A project reopened
tomorrow carries on at `_08` instead of writing over `_01`, and no copy is ever
overwritten. Numbers have two digits up to 99 and grow wider after that. The
match ignores case, because Windows does: `LAMP_07.3doo` and `lamp_07.3doo` are
one file there, and writing the second would replace the first.

Nothing prunes the folder. At the default interval, an hour of work leaves up
to twenty copies.

### Keeping it

The location is a setting of its own, separate from the switch:

- The handle is stored in IndexedDB under `location`.
- The store holds it as `autosaveLocation`, with `autosaveLocationReady`
  saying whether it may be written to right now.
- Turning autosave off keeps the location, so turning it back on writes to the
  same place without asking.

RESET in PREFS is what forgets it. A handle cannot go into a `.pref` file, so
the location is not part of `resetPreferences`. The RESET button calls
`forgetAutosaveLocation` alongside it, which empties `autosaveLocation` and
deletes the IndexedDB record. The row then reads Not chosen, and turning
autosave on asks for a folder again, in this session and the next.

### Permission after a restart

The browser keeps the write permission across a reload, but not across a
restart. After a restart, a handle read back from storage still points at the
folder, but `queryPermission` answers `prompt`, and only a click can ask again.

So on mount `useAutosave` reads the location back (whether autosave is on or
not, so the row can name it) and then:

| State | What happens |
| --- | --- |
| Autosave on, permission lapsed | `AutosaveLocationDialog` opens. ALLOW asks the browser again; TURN AUTOSAVE OFF is the other way out. Closing it leaves autosave on, writing nothing, and the LOCATION row shows ALLOW until permission is given |
| Autosave on, no location at all | Autosave is turned off. This is how a preference saved by an older build arrives, from when every copy lived in the browser |
| Autosave off | Nothing is asked. Turning it on is a click, so a lapsed permission is asked for then |

Chrome 122 and later offer to allow a site on every visit, which ends the
question for good.

The tick itself never asks: a timer has no click to answer a prompt with.
`writeNumberedCopy` checks with `mayWriteNow`, which only queries. A location
the browser has taken back answers `not-allowed`, which lowers
`autosaveLocationReady` and waits for PREFS, instead of raising a warning every
time the timer comes round.

## What counts as a change

Three pieces of state answer three different questions:

| State | Question | Cost |
| --- | --- | --- |
| `dirty` | Has anything been touched since the scene was last stored? | Free: a subscription |
| `savedFingerprint` | Is this scene identical to the one last stored? | A hash of the whole scene |
| `savedToFile` | Is this exact scene in the project's own `.3doo`? | Free: the same subscription |

### `dirty`

A subscription in `useEditorStore` raises `state.dirty`, rather than each
action that edits something. Otherwise the same line would appear in thirty
actions, and the one place it was forgotten would be a change that silently
never reaches the autosave. Renaming an object was exactly that: a rename does
not touch geometry, so it never bumped `meshVersion`, which was what the timer
used to test.

The subscription watches `meshVersion`, `objects`, `groups`, `projectName`,
`cursor` and `assets`. Every edit in the app replaces one of these by
reference, because panels select them and an in-place change would not
re-render. Geometry is the exception, being mutated in place, and `meshVersion`
is what says it moved.

Two things are deliberately not watched:

- **Object selection.** Clicking around a scene is all that somebody who "did
  nothing" did. Edit-mode selection is different: in this kernel a vertex
  carries its own selected flag, the file stores it, and a change to it comes
  through `meshVersion`.
- **Folded panels.** That is layout, not project.

The flag is lowered in four places:

1. After the opening cube, which is the editor's doing, not the user's.
2. After a file is opened.
3. After a file is saved, but only once it is actually written. A dismissed
   dialog or a name already taken leaves the work pending.
4. By the autosave, **before** the write rather than after, so an edit made
   while the write is in flight raises it again and is caught by the next tick.

### The fingerprint: touched is not changed

The flag goes up whenever a watched field is replaced, which is not always a
real change:

- Undo replays a snapshot, replacing every watched field with one holding what
  it held before.
- Folding a folder in the outliner replaces `groups`, though folding never
  reaches the document.
- Switching between vertex, edge and face select, or leaving edit mode, bumps
  `meshVersion` without moving anything.

So the tick checks what it is about to write. `sceneFingerprint` in
`autosave.ts` hashes the document the tick has just snapshotted, and
`state.savedFingerprint` holds the hash of the scene last stored. If they are
equal, that scene is already in a file: the tick lowers the flag and writes
nothing, with no numbered copy and no disk.

- **Who sets it:** everything that stores a scene. The tick itself, a save and
  an open.
- **Who leaves it null:** the opening cube, a new project, and a write that
  failed. No file is known to hold those scenes, and null matches nothing.
- **What it covers:** what a file would hold differently, and nothing else. It
  leaves out `savedAt`, `activeObjectId` and `panels`, the same line the
  subscription draws.
- **Edges count as sets, not lists.** A mesh read back from a document, which
  is what an undo does, rebuilds its edges face by face rather than in the
  order the edits made them. Compared as lists, an extruded mesh taken back one
  step would never match the one stored.

The flag stays even with the hash, because the flag costs nothing and the hash
is a pass over the whole scene. The hash only runs on a tick the flag has let
through, so at most once per tick.

### Is this scene in its own file?

`state.savedToFile` answers a narrower question than `dirty`: not "is this
scene in some file?" but "is this exact scene in the project's own `.3doo`?"

- A save raises it, and so does an open, since the file the scene came from is
  still there.
- The subscription that raises `dirty` lowers it, so the first edit after a
  save clears it.

It has to be separate because the autosave lowers `dirty` with a numbered copy,
which is a backup, not the project's file. The NEW and OPEN prompt needs this
narrower answer.

**Ordering trap:** Zustand runs subscribers after the `set` that triggered
them. An action that clears this flag inside the same `set` that changes the
scene will see it raised again on the way out. Clear it in a second `set`, as
`resetScene` does.

## Reloading the page

A reload throws the tab away and opens a fresh scene, so everything that is in
no file goes with it. `beforeunload` can only show the browser's own generic
wording, so the editor catches the reload keys instead. `reloadShortcut` in the
keymap names them, and `useKeymap` handles them before anything else, including
the guard that keeps shortcuts out of text fields: a refresh is a refresh
whatever has focus.

| Key | When `dirty` | When nothing has changed |
| --- | --- | --- |
| F5, F5 with any modifier, Ctrl+Shift+R | The RELOAD THE PAGE dialog | Passed to the browser untouched |
| Ctrl+R | Loop cut in edit mode; nothing in object mode | The same |

**The RELOAD THE PAGE dialog** offers to save the `.3doo` first, says the
changes are in no file yet, and says where the auto-saves are. Save and reload
waits for the file to be written, so a dismissed picker leaves the dialog
standing. Reload without saving calls `location.reload()`.

**With nothing changed,** the key goes to the browser. The reload loses
nothing, and a prompt about losing nothing is one people learn to click past.
The browser runs it rather than `location.reload()`, which cannot skip the
cache the way a hard reload asks it to. Unlike in front of NEW and OPEN, an
autosave tick counts as a save here: the numbered copies are already the safety
net for the reloads that cannot be caught.

**Ctrl+R is the loop cut**, so it never reaches the browser. In object mode
there is no loop to cut and nothing happens. The key belongs to the editor; it
is not a request to leave, and a dialog about reloading would answer a question
nobody asked. The physical key counts as well as the character, because the
browser reloads on that key position whatever letter a layout prints on it.

Nothing can catch the reload button, Ctrl+W or the address bar. That is what
the numbered copies are for.
