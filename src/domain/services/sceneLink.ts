/**
 * A whole project carried in a link: `/modeling#scene=<payload>`.
 *
 * The payload is the `.3doo` text, deflated and written in base64url, so it
 * survives being pasted into a chat or an address bar. It rides in the hash
 * because a browser never sends that part to the server: a host serving the
 * built files needs nothing to make the link work, and the scene goes nowhere
 * but the tab that opens it.
 */
export const SCENE_LINK_KEY = 'scene';

/**
 * The longest link handed out, in characters.
 *
 * Chromium refuses to navigate past about two million, and a link that will
 * not open is worse than being told to send the `.3doo` instead.
 */
export const MAX_SCENE_LINK_LENGTH = 2_000_000;

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const writer = stream.writable.getWriter();
  // Not awaited: the writes only settle as the far end is read, below.
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});

  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    chunks.push(read.value);
  }

  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

function toBase64Url(bytes: Uint8Array): string {
  // In slices: one call to `fromCharCode` with a megabyte of arguments
  // overflows the stack.
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The project text as a link payload. */
export async function encodeScenePayload(projectText: string): Promise<string> {
  return toBase64Url(
    await pipe(new TextEncoder().encode(projectText), new CompressionStream('deflate-raw')),
  );
}

/** The project text a link payload carries. Throws on one that was cut short or mangled. */
export async function decodeScenePayload(payload: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(payload);
  } catch {
    throw new Error('The link is not a scene link, or it was cut short.');
  }
  try {
    return new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw')));
  } catch {
    throw new Error('The scene in the link was cut short. Copy the whole link and try again.');
  }
}

/** The link that opens `projectText` in the editor served from `appUrl`. */
export async function sceneLink(appUrl: string, projectText: string): Promise<string> {
  const base = appUrl.replace(/[#?].*$/, '').replace(/\/+$/, '');
  const payload = await encodeScenePayload(projectText);
  return `${base}/modeling#${SCENE_LINK_KEY}=${payload}`;
}

/** The payload in a location hash, or null when the hash carries no scene. */
export function scenePayloadIn(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const payload = params.get(SCENE_LINK_KEY);
  return payload && payload.trim() !== '' ? payload.trim() : null;
}
