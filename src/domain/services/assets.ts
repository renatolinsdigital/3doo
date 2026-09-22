import type { ProjectAssetData } from '@kernel/index';
import type { SceneAsset } from '@store/types';

/**
 * Where imported binaries live in the browser: the Origin Private File System.
 *
 * Not IndexedDB, which holds the project description next door. An image is a
 * file and OPFS stores it as one, with no structure imposed on it and no
 * re-encoding on the way in or out. IndexedDB would have to hold the same bytes
 * as a blob inside a record that is rewritten on every autosave, so a scene
 * with a few reference photographs in it would copy megabytes every tick to
 * save a change to one vertex.
 *
 * Private to this origin and to this browser profile, like every other web
 * storage: nothing here is uploaded and nothing is shared between browsers.
 * Clearing site data takes it with everything else, which is why a `.3doo`
 * carries its own copy (see docs/saving.md).
 */
const ASSET_DIRECTORY = 'assets';

/**
 * `FileSystemDirectoryHandle.keys()`, which the DOM lib does not describe yet.
 *
 * Declared here rather than reached for through `any`: this is the only place
 * that walks the directory, and the shape it needs is one method.
 */
type DirectoryEntries = FileSystemDirectoryHandle & { keys: () => AsyncIterable<string> };

function storedNames(directory: FileSystemDirectoryHandle): AsyncIterable<string> {
  return (directory as DirectoryEntries).keys();
}

/** Whether this browser offers OPFS at all. */
export function assetStorageAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

async function assetDirectory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!assetStorageAvailable()) return null;

  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(ASSET_DIRECTORY, { create });
  } catch {
    // Missing when nothing has been written yet, and refused outright in some
    // private-browsing modes. Neither is a reason to fail the editor: the
    // session keeps its images in memory and the file save still carries them.
    return null;
  }
}

export async function writeAsset(id: string, blob: Blob): Promise<boolean> {
  const directory = await assetDirectory(true);
  if (!directory) return false;

  try {
    const handle = await directory.getFileHandle(id, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (error) {
    console.warn('3DOO: could not store asset', id, error);
    return false;
  }
}

export async function readAsset(id: string): Promise<Blob | null> {
  const directory = await assetDirectory(false);
  if (!directory) return null;

  try {
    const handle = await directory.getFileHandle(id);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function deleteAsset(id: string): Promise<void> {
  const directory = await assetDirectory(false);
  if (!directory) return;

  try {
    await directory.removeEntry(id);
  } catch {
    // Already gone, which is the state the caller wanted.
  }
}

/** Empties the store, for a new project or a scene that dropped its last image. */
export async function clearAssets(): Promise<void> {
  const directory = await assetDirectory(false);
  if (!directory) return;

  try {
    const names: string[] = [];
    for await (const name of storedNames(directory)) names.push(name);
    for (const name of names) await directory.removeEntry(name);
  } catch (error) {
    console.warn('3DOO: could not clear assets', error);
  }
}

/**
 * Writes the session's assets and drops any file nothing points at any more.
 *
 * Run with each autosave rather than on delete, because a delete is undoable:
 * a file removed the moment its object went would have to come back, and the
 * next autosave is the first point at which the scene is known to have settled
 * without it.
 */
export async function syncAssets(assets: readonly SceneAsset[]): Promise<void> {
  const directory = await assetDirectory(true);
  if (!directory) return;

  const wanted = new Map(assets.map((asset) => [asset.id, asset]));

  try {
    const stored = new Set<string>();
    for await (const name of storedNames(directory)) stored.add(name);

    for (const [id, asset] of wanted) {
      if (stored.has(id) || !asset.blob) continue;
      await writeAsset(id, asset.blob);
    }
    for (const id of stored) {
      if (!wanted.has(id)) await directory.removeEntry(id);
    }
  } catch (error) {
    console.warn('3DOO: could not sync assets', error);
  }
}

/**
 * The assets a document names, with their bytes.
 *
 * Bytes come from the document itself when it has them (a `.3doo` being
 * opened) and from OPFS when it does not (a session being recovered). An asset
 * neither place can supply is still returned, without bytes, so the scene can
 * say which picture is missing rather than drawing a blank plane in silence.
 */
export async function hydrateAssets(described: readonly ProjectAssetData[]): Promise<SceneAsset[]> {
  return Promise.all(
    described.map(async (asset) => ({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      width: asset.width,
      height: asset.height,
      blob: asset.data ? base64ToBlob(asset.data, asset.type) : await readAsset(asset.id),
    })),
  );
}

/** The document's asset list with the bytes inlined, which is what a file carries. */
export async function inlineAssets(
  described: readonly ProjectAssetData[],
  assets: Record<string, SceneAsset>,
): Promise<ProjectAssetData[]> {
  return Promise.all(
    described.map(async (asset) => {
      const blob = assets[asset.id]?.blob ?? (await readAsset(asset.id));
      if (!blob) return { ...asset };
      return { ...asset, data: await blobToBase64(blob) };
    }),
  );
}

/**
 * Base64 of a blob, without the `data:` prefix a reader puts in front of it.
 *
 * Through `FileReader` rather than `btoa` over the bytes: a megabyte of image
 * is a megabyte of arguments to `String.fromCharCode`, which overflows the call
 * stack on the sizes people actually import.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Extension to MIME type, for browsers that hand over a file with neither. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
};

export function imageTypeFor(filename: string, declared: string): string {
  if (declared.startsWith('image/')) return declared;
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  return IMAGE_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * The natural pixel size of an image file.
 *
 * `createImageBitmap` where the browser has it, which decodes off the main
 * thread and knows every format the renderer does. The `Image` fallback covers
 * the ones that do not, and both are behind the same promise so the caller
 * never has to care which ran.
 */
export async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      // Falls through to the element below, which fails with its own message.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not an image this browser can read'));
    };
    image.src = url;
  });
}

let assetCounter = 0;

/**
 * An id for a newly imported asset.
 *
 * Time plus a counter rather than the file's name: the same drawing imported
 * twice is two assets, and a name is not something a stored file should have to
 * be unique on.
 */
export function nextAssetId(): string {
  assetCounter += 1;
  return `asset-${Date.now().toString(36)}-${assetCounter}`;
}
