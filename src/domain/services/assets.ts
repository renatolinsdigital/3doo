import { type ProjectAssetData, type ProjectDocument, stringifyProject } from '@kernel/index';
import type { SceneAsset } from '@store/types';

/**
 * The assets a document names, with their bytes.
 *
 * A `.3doo` carries each image inside it as base64, which is the only place
 * the bytes are kept outside the tab: the browser stores nothing of a project.
 * An asset that arrives without them is still returned, with none, so the
 * scene can say which picture is missing rather than drawing a blank plane in
 * silence.
 */
export function hydrateAssets(described: readonly ProjectAssetData[]): SceneAsset[] {
  return described.map((asset) => ({
    id: asset.id,
    name: asset.name,
    type: asset.type,
    width: asset.width,
    height: asset.height,
    blob: asset.data ? base64ToBlob(asset.data, asset.type) : null,
  }));
}

/** The document's asset list with the bytes inlined, which is what a file carries. */
export async function inlineAssets(
  described: readonly ProjectAssetData[],
  assets: Record<string, SceneAsset>,
): Promise<ProjectAssetData[]> {
  return Promise.all(
    described.map(async (asset) => {
      const blob = assets[asset.id]?.blob;
      if (!blob) return { ...asset };
      return { ...asset, data: await blobToBase64(blob) };
    }),
  );
}

/**
 * What a `.3doo` holds: the document as JSON, with its images inlined.
 *
 * SAVE writes this over the project's file and autosave writes it as each
 * numbered copy, so an auto-save opens on its own the way a saved file does.
 */
export async function projectText(
  document: ProjectDocument,
  assets: Record<string, SceneAsset>,
): Promise<string> {
  return stringifyProject({
    ...document,
    assets: await inlineAssets(document.assets ?? [], assets),
  });
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

/** A blob's bytes, through `FileReader` like `blobToBase64`. */
export function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsArrayBuffer(blob);
  });
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/bmp': 'bmp',
};

/**
 * The name an image goes out under beside an exported model, unique among
 * `taken`, which it joins.
 *
 * Spaces become underscores, since an OBJ material file reads up to the first
 * one, and a name with no extension gets one from its type so the importer
 * knows what it is reading. Uniqueness ignores case, as Windows does.
 */
export function exportFileName(asset: SceneAsset, taken: Set<string>): string {
  let name = asset.name.trim().replace(/\s+/g, '_') || 'image';
  if (!/\.[a-z0-9]+$/i.test(name)) name = `${name}.${IMAGE_EXTENSIONS[asset.type] ?? 'png'}`;

  const dot = name.lastIndexOf('.');
  let candidate = name;
  for (let copy = 2; taken.has(candidate.toLowerCase()); copy++) {
    candidate = `${name.slice(0, dot)}_${copy}${name.slice(dot)}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
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
