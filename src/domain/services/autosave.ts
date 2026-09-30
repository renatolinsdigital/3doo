import type { ProjectDocument } from '@kernel/index';

import {
  type FolderPick,
  PROJECT_FILE,
  mayWriteNow,
  pickFolder,
  withoutProjectSuffix,
} from './download';

const DATABASE_NAME = '3doo';
const STORE_NAME = 'autosave';
/** The location the user chose for the numbered copies. */
const LOCATION_KEY = 'location';
/**
 * Where earlier builds kept a copy of the project in this browser: the record
 * in IndexedDB, and the imported images beside it in OPFS. Only ever deleted
 * now (see `forgetBrowserCopy`).
 */
const OLD_RECORD_KEY = 'latest';
const OLD_ASSET_DIRECTORY = 'assets';

/**
 * The folder the numbered copies go in, made inside whichever location the
 * user chooses. One folder of their own keeps a busy location from filling up
 * with copies between everything else in it.
 */
export const AUTOSAVE_FOLDER = '3doo-auto-saves';

/** An edge list as one sorted key per edge, whatever order and way round it was listed in. */
function edgeSet(edges: readonly [number, number][], verts: number): number[] {
  const keys = Float64Array.from(edges, ([a, b]) => Math.min(a, b) * verts + Math.max(a, b));
  return Array.from(keys.sort());
}

/**
 * cyrb53: 53 bits, so two different scenes sharing a fingerprint is not a
 * thing to plan for, in one pass over the text.
 */
function hashText(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A number that comes out the same for two documents holding the same scene.
 *
 * What the autosave checks before it writes, because `dirty` only says the
 * scene was touched, and touched is not changed: an edit taken back with
 * Ctrl+Z, a folder folded in the outliner or a switch from vertex to face
 * select all raise it on a scene the last save already holds.
 *
 * Leaves out what a document carries besides the scene, as the flag does:
 * when it was written, which object was active and which panels were folded.
 * Edges count as sets. A mesh read back from a document, which is how undo
 * puts one back, builds its edges face by face rather than in the order the
 * edits made them, and without this an edit taken back would never read as
 * the scene it went back to.
 */
export function sceneFingerprint(document: ProjectDocument): number {
  const text = JSON.stringify({
    ...document,
    // Undefined is left out of the text altogether.
    savedAt: undefined,
    activeObjectId: undefined,
    panels: undefined,
    objects: document.objects.map((object) => {
      const { mesh } = object;
      const verts = mesh.positions.length / 3;
      return {
        ...object,
        mesh: {
          ...mesh,
          wireEdges: edgeSet(mesh.wireEdges, verts),
          sharpEdges: edgeSet(mesh.sharpEdges, verts),
          selection: { ...mesh.selection, edges: edgeSet(mesh.selection.edges, verts) },
        },
      };
    }),
  });
  return hashText(text);
}

/**
 * The one thing autosave keeps in the browser: the handle of the location the
 * user chose, in IndexedDB, which is the only storage a handle survives in.
 * The project itself only ever goes into `.3doo` files.
 *
 * Written against the raw API rather than a wrapper library: it is one object
 * store with one record, and every call is wrapped so a browser with storage
 * disabled degrades to asking for the location again instead of breaking the
 * editor.
 */
function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn('3DOO: autosave unavailable', request.error);
      resolve(null);
    };
  });
}

/**
 * Stores `value` under `key`, or deletes the key when `value` is undefined.
 * Resolves true once the transaction has landed.
 */
async function writeKey(key: string, value: unknown): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;

  const action = value === undefined ? 'clear' : 'write';
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      if (value === undefined) store.delete(key);
      else store.put(value, key);
      transaction.oncomplete = () => {
        database.close();
        resolve(true);
      };
      transaction.onerror = () => {
        console.warn(`3DOO: autosave ${action} failed`, key, transaction.error);
        database.close();
        resolve(false);
      };
    } catch (error) {
      console.warn(`3DOO: autosave ${action} threw`, key, error);
      database.close();
      resolve(false);
    }
  });
}

async function readKey<T>(key: string): Promise<T | null> {
  const database = await openDatabase();
  if (!database) return null;

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => {
        database.close();
        resolve((request.result as T | undefined) ?? null);
      };
      request.onerror = () => {
        database.close();
        resolve(null);
      };
    } catch {
      database.close();
      resolve(null);
    }
  });
}

/**
 * Deletes the copy of the project earlier builds kept in this browser.
 *
 * Nothing reads it any more, and a project left sitting in browser storage is
 * exactly what autosave no longer does. Best effort, since there is usually
 * nothing there to delete.
 */
export async function forgetBrowserCopy(): Promise<void> {
  await writeKey(OLD_RECORD_KEY, undefined);
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(OLD_ASSET_DIRECTORY, { recursive: true });
  } catch {
    // Never written, or storage refused outright: either way nothing is left.
  }
}

/** The location chosen for the numbered copies, as the editor last left it. */
export function readAutosaveLocation(): Promise<FileSystemDirectoryHandle | null> {
  return readKey<FileSystemDirectoryHandle>(LOCATION_KEY);
}

/**
 * Remembers the location chosen for the numbered copies.
 *
 * Kept so that after a restart the browser only has to be asked for
 * permission again, rather than for the folder: a handle read back out of
 * storage leads to the same place, though not always with leave to write.
 */
export function writeAutosaveLocation(location: FileSystemDirectoryHandle): Promise<boolean> {
  return writeKey(LOCATION_KEY, location);
}

/** Forgets the location chosen for the numbered copies, so the next session starts with none. */
export function clearAutosaveLocation(): Promise<boolean> {
  return writeKey(LOCATION_KEY, undefined);
}

function isAutosaveFolder(folder: FileSystemDirectoryHandle): boolean {
  return folder.name.toLowerCase() === AUTOSAVE_FOLDER;
}

/**
 * The folder inside `location` the copies go in: the location itself when it
 * already is one (a name typed by hand, so its case is whatever was typed),
 * otherwise a `3doo-auto-saves` made inside it.
 *
 * Asked for again at every write rather than kept, so a folder deleted
 * between two ticks is simply made again.
 */
export function autosaveFolderIn(
  location: FileSystemDirectoryHandle,
): Promise<FileSystemDirectoryHandle> {
  if (isAutosaveFolder(location)) return Promise.resolve(location);
  return location.getDirectoryHandle(AUTOSAVE_FOLDER, { create: true });
}

/**
 * Where the copies go, as the user reads it: `Projects/3doo-auto-saves`.
 *
 * Only the chosen folder's own name, because the browser never tells a page
 * the path to anything.
 */
export function autosaveLocationLabel(location: FileSystemDirectoryHandle): string {
  if (isAutosaveFolder(location)) return location.name;
  // Chromium names the top of a drive by its separator alone, `\` for `D:\`,
  // keeping the letter back like the rest of a path. Stripped, it leaves a
  // plain root: `/3doo-auto-saves`.
  return `${location.name.replace(/[\\/]+$/, '')}/${AUTOSAVE_FOLDER}`;
}

/**
 * Asks the user where the numbered copies go.
 *
 * Opens where the current location is, or in Documents the first time. The
 * `3doo-auto-saves` folder is made there and then, rather than at the first
 * write, so a location that cannot take it says so while the user is still
 * choosing.
 */
export async function pickAutosaveLocation(
  current: FileSystemDirectoryHandle | null,
): Promise<FolderPick> {
  const pick = await pickFolder(current ?? 'documents');
  if (pick.status !== 'picked') return pick;

  try {
    await autosaveFolderIn(pick.folder);
    return pick;
  } catch (error) {
    return { status: 'failed', reason: (error as Error).message };
  }
}

/** Characters Windows refuses in a file name. The others refuse fewer. */
const UNSAFE_IN_NAMES = /[\\/:*?"<>|]/g;

/**
 * What a project's numbered copies are called.
 *
 * The `.3doo` it was saved as or opened from, so `lamp.3doo` gets
 * `lamp_01.3doo`. Before there is one, the name in the top bar, which is
 * `untitled` until somebody types another. A character no file name may hold
 * becomes an underscore.
 */
export function autosaveStem(file: { name: string } | null, projectName: string): string {
  const named = file ? withoutProjectSuffix(file.name) : projectName;
  const stem = named
    .replace(UNSAFE_IN_NAMES, '_')
    .trim()
    .replace(/[. ]+$/, '');
  return stem || 'untitled';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The name the next copy takes: one past the highest already in the folder.
 *
 * Counted from what is there rather than from this session, so a project
 * reopened tomorrow carries on at `_08` instead of writing over `_01`. Case is
 * ignored because Windows ignores it: `LAMP_03.3doo` and `lamp_03.3doo` are
 * one file there, and writing the second would replace the first.
 */
export function nextAutosaveName(stem: string, existing: Iterable<string>): string {
  const extension = PROJECT_FILE.extension;
  const numbered = new RegExp(`^${escapeRegExp(stem)}_(\\d+)${escapeRegExp(extension)}$`, 'i');

  let highest = 0;
  for (const name of existing) {
    const match = numbered.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }

  return `${stem}_${String(highest + 1).padStart(2, '0')}${extension}`;
}

/**
 * How writing a numbered copy ended.
 *
 * `not-allowed` is the browser having taken the permission back, after a
 * restart or from its site settings. Asking again takes a click, which a tick
 * cannot make, so it is not reported as a failure every time the timer runs.
 */
export type NumberedCopy =
  | { status: 'written'; filename: string }
  | { status: 'not-allowed' }
  | { status: 'failed'; reason: string };

/**
 * `FileSystemDirectoryHandle.keys()`, which the DOM lib does not describe yet.
 * Declared here rather than reached for through `any`.
 */
type DirectoryEntries = FileSystemDirectoryHandle & { keys: () => AsyncIterable<string> };

/**
 * Writes `contents` into the location's `3doo-auto-saves` as the next numbered
 * copy, never over one already there.
 */
export async function writeNumberedCopy(
  location: FileSystemDirectoryHandle,
  stem: string,
  contents: string,
): Promise<NumberedCopy> {
  try {
    if (!(await mayWriteNow(location))) return { status: 'not-allowed' };
    const folder = await autosaveFolderIn(location);

    const names: string[] = [];
    for await (const name of (folder as DirectoryEntries).keys()) names.push(name);
    const filename = nextAutosaveName(stem, names);

    const file = await folder.getFileHandle(filename, { create: true });
    const writable = await file.createWritable();
    await writable.write(contents);
    await writable.close();
    return { status: 'written', filename };
  } catch (error) {
    // The folder deleted or renamed out from under the handle, the disk full,
    // a sync client holding the file: the browser's words say which.
    return { status: 'failed', reason: (error as Error).message };
  }
}
