import type { ProjectDocument } from '@kernel/index';

const DATABASE_NAME = '3doo';
const STORE_NAME = 'autosave';
const RECORD_KEY = 'latest';

export interface AutosaveRecord {
  document: ProjectDocument;
  savedAt: string;
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

export async function writeAutosave(document: ProjectDocument): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const record: AutosaveRecord = { document, savedAt: new Date().toISOString() };
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

export async function clearAutosave(): Promise<void> {
  const database = await openDatabase();
  if (!database) return;

  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(RECORD_KEY);
    transaction.oncomplete = () => database.close();
  } catch {
    database.close();
  }
}
