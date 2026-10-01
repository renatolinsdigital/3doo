/** Triggers a browser download for generated text, then releases the blob URL. */
export function downloadFile(filename: string, contents: BlobPart, mimeType = 'text/plain'): void {
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
  const last = filenames[filenames.length - 1];
  const list = filenames.length > 1 ? `${filenames.slice(0, -1).join(', ')} and ${last}` : last;
  return `Saved ${list} to your downloads`;
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
  /**
   * What a refusal says was expected, when `extension` alone would mislead.
   *
   * A kind that reads several formats has no one expected suffix: naming the
   * first of them tells the user to rename a JPG to `.png`.
   */
  expected?: string;
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
 * The picture formats the importer reads.
 *
 * PNG, JPEG and BMP: the three the brief asked for, and three every browser
 * decodes without a library. `extension` goes unused, since images are only
 * ever read.
 */
export const IMAGE_FILE: FileKind = {
  extension: '.png',
  accepts: ['.png', '.jpg', '.jpeg', '.bmp'],
  label: 'a PNG, JPG or BMP image',
  expected: '.png, .jpg, .jpeg or .bmp',
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
  return `${filename} is not ${kind.label}, expected ${kind.expected ?? kind.extension}`;
}

/** A project file's name as the top bar shows it: `lamp.3doo` is `lamp`. */
export function withoutProjectSuffix(filename: string): string {
  const suffix = PROJECT_FILE.accepts.find((accepted) => filename.toLowerCase().endsWith(accepted));
  return suffix ? filename.slice(0, -suffix.length) : filename;
}

interface FilePickerOptions {
  types?: { description: string; accept: Record<string, string[]> }[];
}

interface SaveFilePickerOptions extends FilePickerOptions {
  suggestedName?: string;
}

interface DirectoryPickerOptions {
  startIn?: FileSystemHandle | 'documents';
  mode?: 'readwrite';
}

type SaveFilePicker = (options: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
type OpenFilePicker = (options: FilePickerOptions) => Promise<FileSystemFileHandle[]>;
type DirectoryPicker = (options: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;

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

/** `window.showOpenFilePicker`, where the browser has it, declared for the same reason. */
function openFilePicker(): OpenFilePicker | null {
  const picker = (window as unknown as { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
  return typeof picker === 'function' ? picker.bind(window) : null;
}

/** `window.showDirectoryPicker`, where the browser has it, declared for the same reason. */
function directoryPicker(): DirectoryPicker | null {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker })
    .showDirectoryPicker;
  return typeof picker === 'function' ? picker.bind(window) : null;
}

/**
 * Whether this browser can hand the page a folder to keep auto-saves in.
 *
 * Chromium only. Elsewhere autosave has nowhere to write, so it stays off.
 */
export function canPickFolder(): boolean {
  return directoryPicker() !== null;
}

/**
 * Whether this browser can hand the page a file it may write back to later.
 *
 * Only the pickers do. Without them an open reads a copy and a save is a
 * download, so FILE > SAVE never has a file to write over.
 */
export function canWriteBack(): boolean {
  return saveFilePicker() !== null || openFilePicker() !== null;
}

/**
 * The file FILE > SAVE writes over, or null when it has none.
 *
 * The project's own file, but only while the top bar still carries that
 * file's name. A project renamed since is on its way to a new file, and only
 * SAVE AS can ask where that goes.
 */
export function saveTarget(
  file: FileSystemFileHandle | null,
  projectName: string,
): FileSystemFileHandle | null {
  return file && withoutProjectSuffix(file.name) === projectName ? file : null;
}

/**
 * The filter a picker offers for one kind of file.
 *
 * Keyed by a private type rather than a real one, because Chromium widens the
 * filter with every extension the system has registered for the key: under
 * `application/json` the dialog offers `.json` too.
 */
function pickerTypes(kind: FileKind, extensions: readonly string[]): FilePickerOptions['types'] {
  return [
    {
      description: kind.label,
      accept: { [`application/x-${kind.extension.slice(1)}`]: [...extensions] },
    },
  ];
}

/**
 * Where a save got to.
 *
 * `saved`: written where the user put it, through `handle`.
 * `downloaded`: no picker available, so the browser placed it.
 * `exists`: refused rather than overwrite.
 * `cancelled`: the user dismissed the dialog.
 * `failed`: there was a file to write and the write did not land.
 */
export type SaveResult =
  | { status: 'saved'; filename: string; handle: FileSystemFileHandle }
  | { status: 'downloaded' | 'exists' | 'cancelled'; filename: string }
  | { status: 'failed'; filename: string; reason: string };

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
    downloadFile(suggestedName, contents, mimeType);
    return { status: 'downloaded', filename: suggestedName };
  }

  let handle: FileSystemFileHandle;
  try {
    handle = await picker({
      suggestedName,
      // The canonical extension alone, not every suffix opening will take: a
      // save dialog offering `.3doo.json` invites new files to be named with a
      // spelling that exists only so older ones still open.
      types: pickerTypes(kind, [kind.extension]),
    });
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') {
      return { status: 'cancelled', filename: suggestedName };
    }
    // Any other refusal from the picker (a suffix it dislikes, a blocked
    // permission) must not cost the user the save, so take the plain route.
    downloadFile(suggestedName, contents, mimeType);
    return { status: 'downloaded', filename: suggestedName };
  }

  const existing = await handle.getFile();
  if (existing.size > 0) return { status: 'exists', filename: handle.name };

  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
  return { status: 'saved', filename: handle.name, handle };
}

const WRITE_ACCESS = { mode: 'readwrite' } as const;

/**
 * `queryPermission` and `requestPermission`, which are Chromium's and missing
 * from the DOM lib. Where they are absent the write goes ahead, and the browser
 * refuses it on its own if it has to.
 */
type PermissionCalls = FileSystemHandle & {
  queryPermission?: (access: typeof WRITE_ACCESS) => Promise<PermissionState>;
  requestPermission?: (access: typeof WRITE_ACCESS) => Promise<PermissionState>;
};

/**
 * Whether the page may write through this handle right now, without asking.
 *
 * What a timer has to settle for: asking needs a click to answer it, and an
 * autosave tick is not one.
 */
export async function mayWriteNow(handle: FileSystemHandle): Promise<boolean> {
  const permissions = handle as PermissionCalls;
  if (!permissions.queryPermission) return true;
  return (await permissions.queryPermission(WRITE_ACCESS)) === 'granted';
}

/** Whether the page may write through this handle, asking the user when it has to. */
export async function mayWrite(handle: FileSystemHandle): Promise<boolean> {
  if (await mayWriteNow(handle)) return true;
  const permissions = handle as PermissionCalls;
  if (!permissions.requestPermission) return true;
  return (await permissions.requestPermission(WRITE_ACCESS)) === 'granted';
}

/**
 * How asking for a folder ended.
 *
 * `picked`: `folder` may be written to, with permission given.
 * `cancelled`: the picker was dismissed, or the browser refused the folder
 * chosen and the user gave up rather than choosing another.
 * `failed`: the browser gave a folder but not the use of it.
 */
export type FolderPick =
  | { status: 'picked'; folder: FileSystemDirectoryHandle }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: string };

/**
 * Asks the user for a folder to write into, which only works inside a click.
 *
 * Chromium refuses a few folders outright: the home folder, the Desktop,
 * Documents and Downloads themselves, while allowing any folder inside them.
 * Picking one of those gets the browser's own notice that it holds system
 * files, and giving up there reaches this as a dismissed picker.
 */
export async function pickFolder(
  startIn: FileSystemDirectoryHandle | 'documents',
): Promise<FolderPick> {
  const picker = directoryPicker();
  if (!picker) return { status: 'failed', reason: 'this browser cannot write to a folder' };

  let picked: FileSystemDirectoryHandle;
  try {
    picked = await picker({ startIn, mode: 'readwrite' });
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') return { status: 'cancelled' };
    return { status: 'failed', reason: (error as Error).message };
  }

  try {
    // Asked for with the pick itself where the browser can. One that cannot
    // hands back a folder it may only read, and this is the second question.
    if (!(await mayWrite(picked))) {
      return { status: 'failed', reason: 'permission to write to it was not given' };
    }
    return { status: 'picked', folder: picked };
  } catch (error) {
    return { status: 'failed', reason: (error as Error).message };
  }
}

/**
 * Writes text over a file picked earlier, with no dialog.
 *
 * A handle from the save picker can already write. One from the open picker
 * can only read, so the first write asks the user, and a refusal is reported
 * rather than treated as a dismissed dialog: nothing else on screen would say
 * why the file did not change.
 */
export async function overwriteTextFile(
  handle: FileSystemFileHandle,
  contents: string,
): Promise<SaveResult> {
  const filename = handle.name;
  try {
    if (!(await mayWrite(handle))) {
      return { status: 'failed', filename, reason: 'permission to write to it was not given' };
    }
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
    return { status: 'saved', filename, handle };
  } catch (error) {
    // Moved, deleted, locked by another program: the browser's own words say
    // which better than a guess made here would.
    return { status: 'failed', filename, reason: (error as Error).message };
  }
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
    case 'failed':
      return { variant: 'error', message: `Could not save ${result.filename}: ${result.reason}` };
    // Dismissing a dialog is a decision, not an event worth a toast.
    case 'cancelled':
      return null;
  }
}

/**
 * Opens a file picker, filtered to one kind, and resolves with the file itself.
 *
 * The file rather than its text, for the kinds that are not text: an image is
 * decoded and stored as the bytes it arrived as.
 */
export function pickFile(kind: FileKind): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = kind.accepts.join(',');

    input.onchange = () => resolve(input.files?.[0] ?? null);

    // A cancelled picker fires no event in most browsers; the promise simply
    // never resolves, which is why callers treat it as fire-and-forget.
    input.click();
  });
}

/** A text file read in, with the way back to it where the browser gave one. */
export interface PickedTextFile {
  name: string;
  text: string;
  /**
   * The file on disk, which FILE > SAVE can write back to.
   *
   * Null when it came through a file input, which hands the page a copy of the
   * contents and nothing that leads back to where they came from.
   */
  handle: FileSystemFileHandle | null;
}

/**
 * Opens a file picker, filtered to one kind, and resolves with its text.
 *
 * Through `showOpenFilePicker` where the browser has it, since that is the only
 * picker that hands back the file itself, and through a file input elsewhere.
 */
export async function pickTextFile(kind: FileKind): Promise<PickedTextFile | null> {
  const picker = openFilePicker();
  if (!picker) return inputTextFile(kind);

  let handle: FileSystemFileHandle;
  try {
    [handle] = await picker({ types: pickerTypes(kind, kind.accepts) });
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') return null;
    // As with a save, any other refusal from the picker must not cost the user
    // the open, so take the plain route.
    return inputTextFile(kind);
  }

  try {
    const file = await handle.getFile();
    return { name: file.name, text: await file.text(), handle };
  } catch {
    return null;
  }
}

async function inputTextFile(kind: FileKind): Promise<PickedTextFile | null> {
  const file = await pickFile(kind);
  if (!file) return null;

  try {
    return { name: file.name, text: await file.text(), handle: null };
  } catch {
    return null;
  }
}
