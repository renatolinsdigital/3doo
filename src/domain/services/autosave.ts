import type { HistoryEntry, HistorySnapshot, ProjectDocument } from '@kernel/index';

const DATABASE_NAME = '3doo';
const STORE_NAME = 'autosave';
const RECORD_KEY = 'latest';

/**
 * How much scene the stored undo timeline may add up to, counted in vertices.
 *
 * Every history entry holds a whole copy of the scene, so a 50 step timeline
 * is 50 scenes, and the record is rewritten in full on every tick. A budget
 * rather than a step count so the cost is the same shape whatever is being
 * modelled: a light scene keeps its whole timeline, a million-vertex one keeps
 * the few steps that fit, and neither spends a tick copying hundreds of
 * megabytes into IndexedDB.
 */
const STORED_HISTORY_VERTS = 300_000;

export interface AutosaveRecord {
  document: ProjectDocument;
  savedAt: string;
  /**
   * The undo timeline as it stood, so a reloaded tab can carry on undoing.
   *
   * Absent on a record written before this was kept, and on one whose scene
   * left no room for a single step. Never part of `document`: a `.3doo` is the
   * scene, not the route taken to it.
   */
  history?: HistorySnapshot;
}

/** What one stored step costs, in vertices, which is what the budget counts. */
function documentVerts(document: ProjectDocument): number {
  let verts = 0;
  for (const object of document.objects) verts += object.mesh.positions.length / 3;
  return verts;
}

/**
 * The newest entries that fit the budget, keeping their order.
 *
 * From the newest end of each half, because the next undo and the next redo
 * are the steps anybody is about to reach for. A step too big to fit stops the
 * walk rather than being skipped over: a timeline with holes in it would undo
 * to the wrong scene.
 */
function fitting(entries: readonly HistoryEntry[], budget: number): HistoryEntry[] {
  const kept: HistoryEntry[] = [];
  let left = budget;

  for (let index = entries.length - 1; index >= 0; index--) {
    const cost = documentVerts(entries[index].document);
    if (cost > left) break;
    left -= cost;
    kept.unshift(entries[index]);
  }

  return kept;
}

/**
 * The timeline trimmed to what is worth storing, or nothing when none of it is.
 *
 * Undo is spent before redo: a tab that comes back with three steps to take
 * back and no steps to put forward is the useful half of a tight budget.
 */
export function storableHistory(history: HistorySnapshot): HistorySnapshot | undefined {
  const past = fitting(history.past, STORED_HISTORY_VERTS);
  const spent = past.reduce((total, entry) => total + documentVerts(entry.document), 0);
  const future = fitting(history.future, STORED_HISTORY_VERTS - spent);

  if (past.length === 0 && future.length === 0) return undefined;
  return { past, future };
}

/**
 * Autosave to IndexedDB.
 *
 * Written against the raw API rather than a wrapper library: it is one object
 * store with a single record, and every call is wrapped so a browser with
 * storage disabled degrades to "no autosave" instead of breaking the editor.
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

export async function writeAutosave(
  document: ProjectDocument,
  history?: HistorySnapshot,
): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const record: AutosaveRecord = {
        document,
        savedAt: new Date().toISOString(),
        history: history && storableHistory(history),
      };
      transaction.objectStore(STORE_NAME).put(record, RECORD_KEY);
      transaction.oncomplete = () => {
        database.close();
        resolve(true);
      };
      transaction.onerror = () => {
        console.warn('3DOO: autosave write failed', transaction.error);
        database.close();
        resolve(false);
      };
    } catch (error) {
      console.warn('3DOO: autosave write threw', error);
      database.close();
      resolve(false);
    }
  });
}

export async function readAutosave(): Promise<AutosaveRecord | null> {
  const database = await openDatabase();
  if (!database) return null;

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY);
      request.onsuccess = () => {
        database.close();
        const value = request.result as AutosaveRecord | undefined;
        resolve(value ?? null);
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
 * Drops the stored project, for a new one starting or a file being opened.
 *
 * Without this the record outlives the scene it was written from. Nothing is
 * written back until an edit raises `dirty` again, so a tab reloaded in
 * between would come back on the project the user had just walked away from,
 * undo timeline and all.
 */
export async function clearAutosave(): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(RECORD_KEY);
      transaction.oncomplete = () => {
        database.close();
        resolve(true);
      };
      transaction.onerror = () => {
        console.warn('3DOO: autosave clear failed', transaction.error);
        database.close();
        resolve(false);
      };
    } catch (error) {
      console.warn('3DOO: autosave clear threw', error);
      database.close();
      resolve(false);
    }
  });
}
