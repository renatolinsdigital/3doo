# Saving

Where a project lives, what holds it, and what the browser keeps of it, which
is nothing.

## Files, and only files

A project exists in two kinds of place, and both are `.3doo` files on disk:

| Copy | Lives in | Written by | Survives |
| --- | --- | --- | --- |
| The file | Wherever you put it | You, with Ctrl+S | Anything, including a different machine |
| The numbered copies | `3doo-auto-saves`, in a location you choose | The editor, on a timer, once autosave is on | Anything, including a different machine |

Both are the same thing written at different moments: a whole `.3doo`, built by
`projectText` in `services/assets.ts`, which SAVE and the autosave both call.
Inside is a `ProjectDocument`, the JSON structure `serializeProject` in the
kernel builds: objects, meshes, transforms, materials, modifiers, groups, the 3D
cursor, which panels were folded, and the imported images as base64.

The browser keeps no copy of a project. Until something is written to a file,
the scene exists only in the tab, and closing or reloading the tab loses it.
That is the trade: nothing of your work sits in browser storage where you cannot
see it, and the way back to it is always a file you can open, move or send.

## What the browser does keep

```text
localStorage ──► preferences               small, synchronous, yours not the project's
IndexedDB    ──► the autosave location     a folder handle, the one thing only it can hold
```

**Preferences** go in `localStorage`, under `3doo:preferences`. They are a few
hundred bytes, they are read once while the store module evaluates (so they have
to be synchronous), and they belong to you rather than to any project: opening a
scene someone sent you must not repaint your viewport. `src/store/slices/preferences.ts`.

**The autosave location** goes in IndexedDB, in database `3doo`, object store
`autosave`, under the key `location`. It is a `FileSystemDirectoryHandle`, which
is not something JSON can hold, and IndexedDB is the only storage a handle
survives in. Kept so that after a restart the browser only has to be asked for
permission again rather than for the folder. `src/domain/services/autosave.ts`.

Earlier builds kept the project itself in that store, under `latest`, with the
imported images in the Origin Private File System beside it. `forgetBrowserCopy`
deletes both when the editor opens, so a browser that ran one of those builds
does not go on holding a project nothing reads.

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

The document's asset list carries the description always and the bytes only in
a file:

```jsonc
// in the .3doo on disk: self-contained
"assets": [{ "id": "asset-1", "name": "ref.png", "type": "image/png",
             "width": 1920, "height": 1080, "data": "iVBORw0KGgo..." }]

// in memory, and in every undo step: the bytes are in state.assets
"assets": [{ "id": "asset-1", "name": "ref.png", "type": "image/png",
             "width": 1920, "height": 1080 }]
```

So the mapping is one step in each direction:

- **tab to file**: `inlineAssets` reads each blob and base64-encodes it into
  `data`, and `projectText` is that plus `stringifyProject`. It is the whole of
  what a save writes, and of what each numbered copy holds.
- **file to tab**: `hydrateAssets` decodes `data` back to a blob. An asset that
  arrives without `data` comes back without bytes, so the object can say which
  picture is missing rather than drawing a blank plane in silence.

Base64 costs about a third on top of the original image, and buys a `.3doo` that
is one file: sending someone a project sends them the pictures in it.

## The autosave

It is off until the user turns it on, from the AUTOSAVE switch in PREFS. The
LOCATION row beside it is where the folder for the numbered copies is chosen
(see [the autosave location](#the-autosave-location)).

`useAutosave`, mounted by `ModelingModule`, does two separate jobs.

**On mount** it opens the editor on a cube, the way Blender does, because an
empty viewport gives you nothing to try a tool against. The cube is an ordinary
undoable add, so one Ctrl+Z gives the empty scene to anyone who wants it. There
is no earlier session to come back to, whatever the AUTOSAVE switch says: the
numbered copies are files, and FILE > OPEN is the way back to one. It also looks
for the folder the numbered copies were going to, which is the next section, and
clears whatever an earlier build left in the browser.

The guard on this is module scope, not a ref. Walking to DOCS and back remounts
the hook, and an empty scene by then is one the user emptied on purpose.

**On a timer** it writes, every `autosaveInterval` seconds, one new numbered
`.3doo` into the folder, and nothing anywhere else. Only when all of this holds:

- AUTOSAVE is on.
- The location may be written to (`autosaveLocationReady`). While it waits for
  the browser's permission nothing is written, and `dirty` stays up, so the
  first tick after it is allowed writes what changed meanwhile.
- The scene has changed since the last save, SAVE's or the timer's (see
  [what counts as a change](#what-counts-as-a-change)). A tab opened and left
  alone writes nothing at all, and neither does one sitting on a scene that has
  already been written: there is no reason to fill a folder with copies of the
  same scene.

A copy that lands says so with the disk in the status bar below, and with
nothing else. A copy that fails outright (the disk full, a sync client holding
the file) is a warning toast in the browser's own words, and puts `dirty` back
up for the next tick to try again. Unless a SAVE landed while the copy was in
flight: that file already holds what the copy could not.

### Saying it happened

A write that lands turns a small floppy disk in the status bar, at the right
of the message slot where it meets the counts. One revolution about its
vertical axis, over 2.5 seconds, at full strength for the middle three
quarters of it so the fade is only the entrance and the exit. An autosave
that leaves no trace is one people do not believe in, and the alternative is
the habit of hitting Ctrl+S every few minutes against a copy that was already
being kept.

No toast goes with it. The disk is enough to say a copy landed, and a message
on every tick, about a write nobody pressed a key for and nobody has to answer,
is noise. Which copy is the newest needs no message either: it is the highest
number in the folder.

It is drawn in bone, the colour the bar writes its own text in, rather than
the amber the flags light in. Amber on this bar means a setting is in force,
and the disk is an event going past rather than a state to read off.

Three details make it honest rather than decorative:

- It is driven by `state.autosaveToken`, a counter the hook bumps **after**
  a copy resolves as landed. Not `dirty`, which is lowered before the write
  goes out and stays lowered while it is in flight: turning on that would draw
  a disk for a write that had not happened, and draw one again for a write that
  failed.
- A counter rather than a timestamp, because two writes a minute apart both
  have to start the animation over, and the status bar compares it against
  the value it last saw rather than against zero. A bar mounting into a
  session that has been writing for an hour, because the status bar was
  switched back on in PREFS or the editor came back from DOCS, has missed
  those writes rather than witnessed them.
- The slot stays in the layout while the disk is out of it, so the status
  message beside it does not shift sideways on every tick.

The disk is `aria-hidden`. It sits inside the message slot, which is a live
region, so announcing it would cut across whatever the editor was saying,
every time the timer came round. The AUTOSAVE preference is where the
behaviour is stated in words, and a copy that fails still says so in its
warning.

Visibility comes from the class and the turn from the `save-spin` keyframes,
which is what keeps the reduced-motion rule in `animations.scss` from taking
the disk away along with its animation: that viewport gets the disk, held
steady and face on, for the same 2.5 seconds. `SAVE_SPIN_MS` and the
keyframes are a pair. Move one without the other and the disk is either cut
off mid-turn or left standing still at the end of it.

### The interval

30 seconds, 1, 2, 3, 5, 10 or 15 minutes, from a picker in preferences, 3
minutes by default. A short list rather than a free number: the difference
between seven minutes and eight is nothing anybody needs, and the trade is easy
to state. Shorter costs less when a tab dies; longer leaves fewer copies in the
folder and stops a heavy scene being serialised so often.

## The autosave location

The numbered copies go in a folder called `3doo-auto-saves`, inside a location
the user chooses: one folder for every project.

### Choosing it

A page cannot reach a folder on disk until the user hands it one, through
`showDirectoryPicker`, and that only opens inside a click. PREFS gives it a row
of its own, LOCATION, under the AUTOSAVE switch: the chosen folder's name, and
CHOOSE or CHANGE to run the picker (`chooseAutosaveLocation` in
`useAutosave.ts`). The switch can run it too. Turned on with no location chosen
yet, `turnAutosaveOn` asks for one there and then, and a dismissed picker
leaves autosave off.

The picker opens in Documents the first time and in the current location after
that, and asks to write there (`mode: 'readwrite'`), which is the permission
prompt the user sees. It cannot hand over everything: Chromium refuses the home
folder, the Desktop, Documents and Downloads themselves, while allowing any
folder inside them. Picking one of those gets Chrome's own notice about system
files, and giving up there reaches the page as an ordinary dismissal. The PREFS
hint says which folders to avoid.

`pickAutosaveLocation` in `autosave.ts` keeps whatever comes back as the
location, and `autosaveFolderIn` finds the folder the copies go in: the location
itself when it is called `3doo-auto-saves` (in any case, since it was typed by
hand), or one made inside it otherwise. It is made there and then, so a location
that cannot take it says so while the user is still choosing, and asked for
again at every write, so one deleted between two ticks is simply made again.
The row shows the result as `Projects/3doo-auto-saves`: only the chosen folder's
own name, because the browser never tells a page the path to anything. The top
of a drive is the one exception. Chromium names it by its separator alone, `\`
for `D:\`, holding the drive letter back like the rest of the path, so the row
drops the separator and shows a plain root, `/3doo-auto-saves`, rather than
`\/3doo-auto-saves`.

Only Chromium browsers have the picker. Elsewhere `canPickFolder()` is false,
and autosave has nowhere to write: the switch is greyed out with a hint saying
why, the LOCATION row is not shown, and a preference that arrives switched on
is turned off when the editor opens.

### What the copies are called

`autosaveStem` names them after the `.3doo` the project was saved as or opened
from, so `lamp.3doo` gets `lamp_01.3doo`, `lamp_02.3doo` and on. Before there is
a file it takes the project name from the top bar, which is `untitled` until
somebody types another, so a project nobody has named writes `untitled_01.3doo`.
A character Windows refuses in a file name becomes an underscore. The name is
read at the moment of writing, so a SAVE AS renames every copy after it.

`nextAutosaveName` counts from what is in the folder rather than from the
session: one past the highest number already there for that name, two digits
until the ninety-ninth and wider after. A project reopened tomorrow carries on
at `_08` instead of writing over `_01`, and nothing is ever written over.
The match ignores case, because Windows does: `LAMP_07.3doo` and `lamp_07.3doo`
are one file there, and writing the second would replace the first.

Nothing prunes the folder. Every write with a change in it leaves one more file,
so at the default interval a working hour leaves up to twenty.

### Keeping it

The location is a setting, not part of the switch. Its handle is stored in
IndexedDB under `location`, and the store holds it as `autosaveLocation`, with
`autosaveLocationReady` saying whether it may be written to right now. Turning
autosave off keeps the location, so turning it back on writes to the same place
without asking where.

RESET in PREFS is what forgets it. A handle cannot go into a `.pref` file, so
the location is no part of `resetPreferences`, and the button calls
`forgetAutosaveLocation` beside it: that empties `autosaveLocation` and deletes
the IndexedDB record, so the row reads Not chosen and turning autosave on asks
for a folder again, in this session and the next.

The browser keeps the permission across a reload. After a restart a handle read
back out of storage still leads to the folder but comes back asking
(`queryPermission` answers `prompt`), and only a click can ask again. So on
mount `useAutosave` reads the location back, whether autosave is on or not, so
the row can name it. With autosave on and the permission lapsed,
`AutosaveLocationDialog` opens: ALLOW asks the browser again, and TURN AUTOSAVE
OFF is the other way out. Closing it leaves autosave on with nothing written
until the location is allowed, and the LOCATION row shows ALLOW meanwhile.
Turning autosave on is a click as well, so a lapsed permission is asked for
there too. Chrome 122 and later offer to allow a site on every visit, which
ends the question for good.

Autosave found on with no location at all is turned off rather than asked
about. That is how a preference saved by a build that kept every copy in the
browser arrives, and autosave starts off until somebody says where it goes.

The tick never asks. `writeNumberedCopy` checks with `mayWriteNow`, which only
queries: a timer has no click to answer a prompt with. A location the browser
has taken back comes back as `not-allowed`, which lowers
`autosaveLocationReady` and waits for PREFS, rather than raising a warning every
time the timer comes round.

## What counts as a change

`state.dirty` says whether the project has been touched since it was last
stored, and it is raised by a subscription in `useEditorStore` rather than by
each action that edits something. The alternative is the same line in thirty
actions, and the one place it gets forgotten is a change that silently never
reaches the autosave. That is exactly how renaming an object came to be left out
of it: a rename does not touch geometry, so it never bumped `meshVersion`, which
was what the timer used to test.

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

The flag is lowered in four places: after the opening cube (the editor's doing,
not the user's), after a file is opened, after one is saved, and by the autosave
itself. The autosave lowers it *before* the write rather than after, so an edit
made while the write is in flight raises it again and is caught by the next tick
instead of being swallowed by this one. A save lowers it only once the file is
actually written: a dismissed dialog and a name already taken both leave the
work pending.

### Touched is not changed

The flag goes up when a watched field is replaced, which is not always the
scene changing. An edit taken back with Ctrl+Z replays a snapshot, so every
watched field is replaced by one holding what it held before. Folding a folder
in the outliner replaces `groups`, though whether a folder is folded never
reaches the document. Switching between vertex, edge and face select, or
leaving edit mode, bumps `meshVersion` without moving anything.

So the tick checks what it is about to write before writing it.
`sceneFingerprint` in `autosave.ts` hashes the document the tick has just
snapshotted, and `state.savedFingerprint` holds the same hash of the scene last
stored. Equal means that scene is already in a file: the tick lowers the flag
and writes nothing, no numbered copy and no disk in the status bar.
Everything that stores a scene sets it: the tick itself, a save and an open. The
opening cube, a new project and a write that failed outright leave it null,
because no file is known to hold the scene, and null matches nothing.

The hash covers what a file would hold differently and nothing else, the same
line the subscription draws, so `savedAt`, `activeObjectId` and `panels` are
left out. Edge lists count as sets rather than lists. A mesh read back from a
document, which is what an undo does, builds its edges face by face rather than
in the order the edits made them, so compared as written, an extruded mesh
taken back one step would never read as the one stored.

The flag stays because it costs nothing and goes up on every edit, while the
hash is a pass over the whole scene. The hash only runs on a tick the flag has
already let through, so once a tick at most.

### The scene is in the project's file

`state.savedToFile` is the second flag, and it answers a different question:
not "is this scene in some file?" but "is this exact scene sitting in the
project's own `.3doo`?" A save raises it, and so does an open, since the file
the scene came out of is still there. The same subscription that raises `dirty`
takes it away again, so the first edit after a save is enough.

The two are separate because the autosave lowers `dirty` with a numbered copy,
which is a backup rather than the file the project belongs to. FILE > NEW and
FILE > OPEN below are the places that need the other answer.

One ordering trap is worth knowing about: zustand runs subscribers after the
`set` that triggered them, so an action that clears the flag inside the same
`set` that changes the scene will have it raised again on the way out. Clear it
in a second `set`, as `resetScene` does.

## Save and Save as

FILE > SAVE AS always asks. It opens the browser's save dialog with the project
name suggested, writes a new `.3doo` wherever it is put, and refuses a file that
is already there rather than replacing it.

FILE > SAVE asks nothing. It writes the project straight back over the file it
was opened from or last saved to, which is `state.projectFile`: the
`FileSystemFileHandle` the save or open picker handed back. SAVE AS and OPEN set
it and NEW clears it. An edit leaves it alone, unlike `savedToFile`, because the
project still belongs to that file after it moves on from what the file holds.
A reload starts a fresh scene, so it has none either.

SAVE writes over that file only while the project name in the top bar is still
the file's own name, `lamp` for `lamp.3doo`. A different name is a different
file: a project renamed away from `lamp.3doo` is on its way to a new one, and
only SAVE AS, which offers the new name, can ask where that goes. Typing the old
name back makes SAVE write over `lamp.3doo` again. `saveTarget` in
`services/download.ts` is the rule, and the menu entry and `saveProject` both
ask it.

So the name follows the file. SAVE AS puts the name the dialog settled on into
the top bar, since it need not be the one the dialog was offered, and OPEN puts
the opened file's name there rather than the name saved inside it, which a file
renamed on disk no longer matches. Either way SAVE is ready the moment the file
is. Undo leaves the name alone too: a rename records no step, and replaying a
step from before one would take SAVE away without anyone having typed a thing.

The menu entry is greyed out while SAVE has nothing to write over, and its hint
says why: no file yet, a name that no longer matches it, or a browser that
cannot write back at all.

Ctrl+S is SAVE, but falls through to SAVE AS while there is nothing to write
over, no file yet or a renamed project: a key has no greyed-out state to
explain itself with, so a press that did nothing would read as broken. Ctrl+Shift+S is SAVE AS, as in Blender. The two
prompts that offer a save before something is discarded, the one in front of
NEW and OPEN and the one in front of a reload, go the way Ctrl+S does.

Only a handle leads back to a file, and only the pickers hand one out, which
means Chromium. Elsewhere OPEN reads through a file input, which gives the page a
copy of the contents and nothing that leads back to them, and SAVE AS is a
download the page cannot reach once it lands. SAVE stays greyed out there, and
its hint says why rather than pointing at a SAVE AS that would not help.

A handle from the save picker can write already. One from the open picker can
only read, so the first SAVE after an OPEN has the browser ask for write
permission. A refusal comes back as a failed save with a toast that says so,
rather than as a dismissed dialog: nothing else on screen would explain why the
file did not change.

## What the file leaves out

The undo timeline stays in the tab that made it, and nowhere else.

A file is a scene. Someone opening one wants the model, not the forty steps
whoever made it took to get there, and undoing into a scene they have never seen
is a worse answer than having nothing to undo. The numbered copies are files, so
they leave it out too. `ProjectDocument` has no timeline field at all, which is
what makes this hold without anything having to remember to strip it.

So opening a `.3doo` restores no steps, and `openProject` calls `clearHistory()`
as well: the steps behind the project the file replaced are not steps behind
this one, and one Ctrl+Z would otherwise undo into a scene the file never held.

## Ids in a file

Objects, folders, materials and modifiers are found by id, and a file keeps the
ids it was saved with. The counters that make new ones start again at every page
load, so on a counter alone the next object added after an OPEN could take the
id of one the file had just brought in. The viewport draws one mesh per id, so
the object already on screen vanished under the new one.

Every id made now carries a stamp of the page load that made it
(`object-mdr3k2x1-4`), so it cannot meet one from a file saved by another. A
file written before that, which can hold two objects under one id, is repaired
as it loads: `loadProjectDocument` gives the second a fresh id, and both come
back on screen.

## Replacing the project

FILE > NEW and FILE > OPEN both ask before they run. They cost the same thing:
the scene on screen and every undo step behind it, and undo cannot reach back
across either. `ReplaceProjectDialog` is the one prompt behind both, reading
`dialog === 'newProject'` or `'openProject'` to know which wording and which
route it is standing in front of. With autosave on it says where the numbered
copies are, since they stay and FILE > OPEN brings any of them back, and says
when there are changes none of them has yet.

It offers three ways out, the way every editor with something to lose does:
save and go on, go on anyway, or stay. Saving waits for the file to be written
before anything is discarded, so a dismissed picker leaves the dialog standing
rather than throwing the project away over a save that never happened. The
older wording pointed at Ctrl+S and left the user to find their own way back,
which is how the save gets skipped.

The one exception is a project already saved to its `.3doo` and untouched
since, which is what `savedToFile` says: the work is on disk, so neither NEW nor
OPEN costs anything, and a prompt about losing nothing is one people learn to
click straight past. That is how a real warning gets missed later. Ctrl+O goes
through the same check, because a shortcut is a faster route to the action
rather than a way around what it costs.

An autosave tick is not that exception. A numbered copy is a backup in a folder
of them, not the file the project belongs to, so a scene the autosave has caught
up with is still one worth offering to save.

## Reloading the page

A browser reload throws the tab away and opens a fresh scene, so everything that
is in no file goes with it. The browser does not ask, and `beforeunload` can
only offer its own wording, so the keyboard routes into it are caught instead:
`reloadShortcut` in the keymap names them, and `useKeymap` answers them before
anything else in the handler, including the guard that keeps shortcuts out of
text fields. A refresh is a refresh whatever had focus.

There are two answers, because there are two kinds of key.

**F5, and the hard reloads,** meaning F5 with anything held down with it and
Ctrl+Shift+R, are a reload the user asked for. While anything has changed since
the last save, which is what `dirty` says, they open the RELOAD THE PAGE dialog.
It offers the `.3doo` first, says those changes are in no file yet, and says
where the auto-saves are. Saving and reloading waits for the file to be written
before it reloads, so a dismissed picker leaves the dialog standing rather than
reloading over a save that never happened. Reloading without saving goes
straight to `location.reload()`.

With nothing changed since the last save, the key goes to the browser untouched:
the reload loses nothing, and a prompt about losing nothing is one people learn
to click straight past. The browser runs it rather than `location.reload()`,
which cannot skip the cache the way a hard reload asks it to. An autosave tick
counts as a save here, unlike in front of NEW and OPEN: the numbered copies are
already what stands between a reload and lost work, since the reload button and
the address bar cannot be caught at all.

**Ctrl+R is the loop cut**, so it never reaches the browser at all. In edit mode
it falls through to the keymap and cuts a loop. In object mode there is no loop
to cut and nothing happens: it is a key the editor has taken, not a request to
leave, and answering it with a dialog about reloading would be answering a
question nobody asked.

The physical key counts alongside the character for the Ctrl+R pair. A layout
with another letter printed on that key still reloads on it, because the browser
reads the position.

None of this covers the reload button, Ctrl+W, or the address bar. No page can
intercept those, which is what the numbered copies are for.

## What to reach for

| To | Use |
| --- | --- |
| Keep something past this tab | Ctrl+S, or autosave's numbered copies |
| Send a project to someone | The `.3doo`. Images ride inside it |
| Come back to yesterday's work | Ctrl+O on its file, or on its newest numbered copy |
| Go back to how it was an hour ago | The numbered copy from then, with Ctrl+O |
| Model on a machine that keeps nothing | Leave AUTOSAVE off and save files by hand |
