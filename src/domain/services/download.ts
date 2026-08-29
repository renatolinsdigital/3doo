/** Triggers a browser download for generated text, then releases the blob URL. */
export function downloadText(filename: string, contents: string, mimeType = 'text/plain'): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * How a finished download is announced.
 *
 * The browser decides where the file lands and never tells the page: it may be
 * a download folder, it may be wherever a Save As dialog was pointed. So the
 * message names the files, which is the part that is actually known, and points
 * at the downloads rather than inventing a path.
 *
 * Shared so that every file the app hands over is announced the same way.
 */
export function savedToDownloads(...filenames: readonly string[]): string {
  return `Saved ${filenames.join(' and ')} to your downloads`;
}

/** A kind of file the app reads or writes, named once so nothing drifts. */
export interface FileKind {
  /** Suffix a save is named with, lower case. One extension, not a compound. */
  extension: string;
  /**
   * Every suffix opening will take.
   *
   * The contents are JSON whatever the name says, so the `.json` spelling is
   * accepted too: that covers a file saved before the extension shortened, and
   * one renamed on the way through a tool that only speaks `.json`.
   */
  accepts: readonly string[];
  /** Noun phrase, article included, so "OBJ" does not end up behind an "a". */
  label: string;
}

export const PROJECT_FILE: FileKind = {
  extension: '.3doo',
  accepts: ['.3doo', '.3doo.json'],
  label: 'a project file',
};
export const PREFERENCES_FILE: FileKind = {
  extension: '.pref',
  accepts: ['.pref', '.pref.json'],
  label: 'a preferences file',
};
export const MESH_FILE: FileKind = {
  extension: '.obj',
  accepts: ['.obj'],
  label: 'an OBJ mesh',
};

/**
 * Why a chosen file cannot be read as this kind, or null when it can.
 *
 * The `accept` attribute is only a filter on the dialog, not a guarantee: every
 * browser offers some route around it. So the suffix is checked again here,
 * where refusing costs one clear sentence rather than a parser error about
 * unexpected JSON.
 */
export function wrongKindMessage(filename: string, kind: FileKind): string | null {
  const name = filename.toLowerCase();
  if (kind.accepts.some((suffix) => name.endsWith(suffix))) return null;
  return `${filename} is not ${kind.label}, expected ${kind.extension}`;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}

type SaveFilePicker = (options: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

/**
 * `window.showSaveFilePicker`, where the browser has it.
 *
 * Declared here rather than imported: the DOM lib carries
 * `FileSystemFileHandle` but not the picker that hands one out, and this is the
 * only place that needs it.
 */
function saveFilePicker(): SaveFilePicker | null {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof picker === 'function' ? picker.bind(window) : null;
}

export interface SaveResult {
  /**
   * `saved`: written where the user put it.
   * `downloaded`: no picker available, so the browser placed it.
   * `exists`: refused rather than overwrite.
   * `cancelled`: the user dismissed the dialog.
   */
  status: 'saved' | 'downloaded' | 'exists' | 'cancelled';
  filename: string;
}

/**
 * Writes text to a file the user places themselves.
 *
 * `showSaveFilePicker` is Chromium-only, so Firefox and Safari fall back to the
 * anchor download, where the browser alone decides the destination. The two
 * outcomes are reported separately because only one of them can honestly say
 * where the file went.
 *
 * An existing file is refused rather than replaced. Note the picker creates a
 * zero-byte file the moment a *new* name is chosen, so size (not existence)
 * is what separates "already there" from "just made for us".
 */
export async function saveTextFile(
  suggestedName: string,
  contents: string,
  kind: FileKind,
  mimeType = 'application/json',
): Promise<SaveResult> {
  const picker = saveFilePicker();
  if (!picker) {
    downloadText(suggestedName, contents, mimeType);
    return { status: 'downloaded', filename: suggestedName };
  }

  let handle: FileSystemFileHandle;
  try {
    handle = await picker({
      suggestedName,
      types: [{ description: kind.label, accept: { [mimeType]: [...kind.accepts] } }],
    });
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') {
      return { status: 'cancelled', filename: suggestedName };
    }
    // Any other refusal from the picker (a suffix it dislikes, a blocked
    // permission) must not cost the user the save, so take the plain route.
    downloadText(suggestedName, contents, mimeType);
    return { status: 'downloaded', filename: suggestedName };
  }

  const existing = await handle.getFile();
  if (existing.size > 0) return { status: 'exists', filename: handle.name };

  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
  return { status: 'saved', filename: handle.name };
}

/** How each save outcome is announced. Null when there is nothing to say. */
export function saveResultToast(
  result: SaveResult,
): { variant: 'success' | 'error'; message: string } | null {
  switch (result.status) {
    case 'saved':
      return { variant: 'success', message: `Saved ${result.filename}` };
    case 'downloaded':
      return { variant: 'success', message: savedToDownloads(result.filename) };
    case 'exists':
      return {
        variant: 'error',
        message: `${result.filename} already exists, save under a different name`,
      };
    // Dismissing a dialog is a decision, not an event worth a toast.
    case 'cancelled':
      return null;
  }
}

/** Opens a file picker, filtered to one kind, and resolves with its text. */
export function pickTextFile(kind: FileKind): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = kind.accepts.join(',');

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file
        .text()
        .then((text) => resolve({ name: file.name, text }))
        .catch(() => resolve(null));
    };

    // A cancelled picker fires no event in most browsers; the promise simply
    // never resolves, which is why callers treat it as fire-and-forget.
    input.click();
  });
}
