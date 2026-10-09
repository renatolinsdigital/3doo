/**
 * A whole project carried in a link: `/modeling#scene=<payload>`.
 *
 * The payload is the `.3doo` text, deflated and written in base64url, so it
 * survives being pasted into a chat or an address bar. It rides in the hash
 * because a browser never sends that part to the server: a host serving the
 * built files needs nothing to make the link work, and the scene goes nowhere
 * but the tab that opens it.
 *
 * The same payload can also be handed over by the page that opened the tab,
 * which has no length limit at all: see `SCENE_HANDOVER`.
 */
export const SCENE_LINK_KEY = 'scene';

/**
 * A scene handed over by the page that opened this tab, rather than carried
 * in its address: the page the MCP server's `share_link` saves.
 *
 * 1. The page opens `/modeling#receive` in a new tab.
 * 2. The tab posts `ready` to the page that opened it.
 * 3. The page answers `scene`, with a payload encoded the way a link's is.
 * 4. The tab answers `opened`, or `failed` with the reason.
 *
 * `mcp/tools.ts` keeps a copy of these names for the page it writes, and a
 * test holds the two together.
 */
export const SCENE_HANDOVER = {
  hash: '#receive',
  ready: '3doo:ready',
  scene: '3doo:scene',
  opened: '3doo:opened',
  failed: '3doo:failed',
} as const;

/** How long a tab opened for a hand-over waits for the scene. */
export const HANDOVER_TIMEOUT_MS = 10_000;

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

/** Whether a location hash asks for the scene to be handed over. */
export const asksForHandover = (hash: string) => hash === SCENE_HANDOVER.hash;

/**
 * Asks `page`, the one that opened this tab, for its scene, and resolves the
 * payload it sends. Rejects, saying why, when the page is gone or sends
 * nothing in time.
 */
export function receiveScenePayload(page: Window | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!page || page.closed) {
      reject(new Error('The page that opened this tab is gone. Press OPEN IN 3DOO on it again.'));
      return;
    }

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; payload?: unknown } | null;
      if (event.source !== page || data?.type !== SCENE_HANDOVER.scene) return;
      if (typeof data.payload !== 'string') return;
      stop();
      resolve(data.payload);
    };
    const timer = window.setTimeout(() => {
      stop();
      reject(
        new Error('The page that opened this tab sent nothing. Press OPEN IN 3DOO on it again.'),
      );
    }, HANDOVER_TIMEOUT_MS);
    const stop = () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };

    window.addEventListener('message', onMessage);
    // Any origin, because the page is usually a file on disk, whose origin
    // cannot be named. The message carries nothing but its type.
    page.postMessage({ type: SCENE_HANDOVER.ready }, '*');
  });
}

/** Tells the page that handed a scene over whether it opened. */
export function answerHandover(page: Window, error: Error | null): void {
  page.postMessage(
    error
      ? { type: SCENE_HANDOVER.failed, reason: error.message }
      : { type: SCENE_HANDOVER.opened },
    '*',
  );
}
