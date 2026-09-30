import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PREFERENCES_FILE,
  PROJECT_FILE,
  canPickFolder,
  canWriteBack,
  mayWriteNow,
  overwriteTextFile,
  pickFolder,
  pickTextFile,
  saveTextFile,
  wrongKindMessage,
} from './download';

interface FakeFile {
  size: number;
}

/** Installs a `showSaveFilePicker` that hands back a file of the given size. */
function stubPicker(options: {
  existingSize: number;
  rejectWith?: DOMException | Error;
  name?: string;
}) {
  const written: string[] = [];
  const calls: { suggestedName?: string; accept: Record<string, string[]> }[] = [];

  const picker = vi.fn((request: { suggestedName?: string; types?: { accept: object }[] }) => {
    calls.push({
      suggestedName: request.suggestedName,
      accept: (request.types?.[0]?.accept ?? {}) as Record<string, string[]>,
    });
    if (options.rejectWith) return Promise.reject(options.rejectWith);

    return Promise.resolve({
      name: options.name ?? 'chosen.3doo',
      getFile: () => Promise.resolve({ size: options.existingSize } as FakeFile),
      createWritable: () =>
        Promise.resolve({
          write: (contents: string) => {
            written.push(contents);
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        }),
    });
  });

  Object.assign(window, { showSaveFilePicker: picker });
  return { written, calls };
}

/** jsdom implements neither half of the blob-URL pair the download path needs. */
function stubDownload() {
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:stub'),
    revokeObjectURL: vi.fn(),
  });
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
}

describe('saveTextFile', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    vi.restoreAllMocks();
  });

  it('writes through the picker and reports the name the user settled on', async () => {
    const { written, calls } = stubPicker({ existingSize: 0 });

    const result = await saveTextFile('suggested.3doo', '{"a":1}', PROJECT_FILE);

    expect(result).toMatchObject({ status: 'saved', filename: 'chosen.3doo' });
    // The way back to the file, for SAVE to write over later.
    expect(result.status === 'saved' && result.handle.name).toBe('chosen.3doo');
    expect(written).toEqual(['{"a":1}']);
    // Only the canonical suffix is offered to save under, keyed by a type the
    // browser has nothing else registered against: the .json spelling is there
    // for opening older files, not for naming new ones.
    expect(calls[0]).toEqual({
      suggestedName: 'suggested.3doo',
      accept: { 'application/x-3doo': ['.3doo'] },
    });
  });

  it('refuses a file that already has contents, without writing to it', async () => {
    const { written } = stubPicker({ existingSize: 4096, name: 'taken.3doo' });

    const result = await saveTextFile('suggested.3doo', 'new contents', PROJECT_FILE);

    expect(result).toEqual({ status: 'exists', filename: 'taken.3doo' });
    // The point of refusing: the file on disk is left exactly as it was.
    expect(written).toEqual([]);
  });

  it('treats a dismissed dialog as a decision, not a failure', async () => {
    stubPicker({
      existingSize: 0,
      rejectWith: new DOMException('The user aborted a request.', 'AbortError'),
    });

    const result = await saveTextFile('suggested.3doo', '{}', PROJECT_FILE);

    expect(result).toEqual({ status: 'cancelled', filename: 'suggested.3doo' });
  });

  it('still saves when the picker itself refuses for any other reason', async () => {
    // A suffix the browser dislikes, a blocked permission: whatever it is, the
    // save must not be lost, so the plain download takes over.
    stubPicker({ existingSize: 0, rejectWith: new TypeError('bad extension') });
    const click = stubDownload();

    const result = await saveTextFile('suggested.3doo', '{}', PROJECT_FILE);

    expect(result).toEqual({ status: 'downloaded', filename: 'suggested.3doo' });
    expect(click).toHaveBeenCalled();
  });

  it('falls back to a download where the browser has no picker at all', async () => {
    const click = stubDownload();

    const result = await saveTextFile('suggested.3doo', '{}', PROJECT_FILE);

    // Firefox and Safari land here, where the browser alone decides where the
    // file goes, which is why the status is reported separately.
    expect(result).toEqual({ status: 'downloaded', filename: 'suggested.3doo' });
    expect(click).toHaveBeenCalled();
  });
});

/** A file picked earlier, with Chromium's permission calls answering as asked. */
function stubHandle(
  options: {
    permission?: PermissionState;
    granted?: PermissionState;
    refuseWrite?: DOMException;
    permissionApi?: boolean;
  } = {},
) {
  const written: string[] = [];
  const requestPermission = vi.fn(() => Promise.resolve(options.granted ?? 'granted'));
  const handle = {
    name: 'scene.3doo',
    createWritable: () =>
      options.refuseWrite
        ? Promise.reject(options.refuseWrite)
        : Promise.resolve({
            write: (contents: string) => {
              written.push(contents);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
    ...(options.permissionApi === false
      ? {}
      : {
          queryPermission: () => Promise.resolve(options.permission ?? 'granted'),
          requestPermission,
        }),
  };
  return { handle: handle as unknown as FileSystemFileHandle, written, requestPermission };
}

describe('overwriteTextFile', () => {
  it('writes over the file with no dialog when it may already write', async () => {
    const { handle, written, requestPermission } = stubHandle();

    const result = await overwriteTextFile(handle, '{"a":1}');

    expect(result).toEqual({ status: 'saved', filename: 'scene.3doo', handle });
    expect(written).toEqual(['{"a":1}']);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('asks first when the file was only opened for reading', async () => {
    const { handle, written, requestPermission } = stubHandle({ permission: 'prompt' });

    const result = await overwriteTextFile(handle, '{}');

    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(result.status).toBe('saved');
    expect(written).toEqual(['{}']);
  });

  it('leaves the file alone, and says why, when writing is not allowed', async () => {
    const { handle, written } = stubHandle({ permission: 'prompt', granted: 'denied' });

    const result = await overwriteTextFile(handle, '{}');

    expect(result).toEqual({
      status: 'failed',
      filename: 'scene.3doo',
      reason: 'permission to write to it was not given',
    });
    expect(written).toEqual([]);
  });

  it('reports a write the browser refuses in its own words', async () => {
    const { handle } = stubHandle({
      refuseWrite: new DOMException('The file is in use', 'NoModificationAllowedError'),
    });

    const result = await overwriteTextFile(handle, '{}');

    expect(result).toEqual({
      status: 'failed',
      filename: 'scene.3doo',
      reason: 'The file is in use',
    });
  });

  it('goes ahead where the browser has no permission calls to make', async () => {
    const { handle, written } = stubHandle({ permissionApi: false });

    const result = await overwriteTextFile(handle, '{}');

    expect(result.status).toBe('saved');
    expect(written).toEqual(['{}']);
  });
});

/** jsdom's `File` has no `text()`, so the pickers hand over one that does. */
function textFile(name: string, text: string) {
  return { name, text: () => Promise.resolve(text) };
}

describe('pickTextFile', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'showOpenFilePicker');
    vi.restoreAllMocks();
  });

  it('reads through the open picker and keeps the way back to the file', async () => {
    const handle = {
      name: 'scene.3doo',
      getFile: () => Promise.resolve(textFile('scene.3doo', '{"a":1}')),
    };
    const picker = vi.fn((_request: { types?: { accept: object }[] }) => Promise.resolve([handle]));
    Object.assign(window, { showOpenFilePicker: picker });

    const result = await pickTextFile(PROJECT_FILE);

    expect(result).toEqual({ name: 'scene.3doo', text: '{"a":1}', handle });
    // Every suffix opening takes, under the same private type a save uses.
    expect(picker.mock.calls[0][0].types?.[0].accept).toEqual({
      'application/x-3doo': ['.3doo', '.3doo.json'],
    });
  });

  it('treats a dismissed picker as nothing chosen', async () => {
    Object.assign(window, {
      showOpenFilePicker: () =>
        Promise.reject(new DOMException('The user aborted a request.', 'AbortError')),
    });

    expect(await pickTextFile(PROJECT_FILE)).toBeNull();
  });

  it('reads through a file input where there is no picker, with no way back', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, 'files', { value: [textFile('scene.3doo', '{}')] });
      this.onchange?.(new Event('change'));
    });

    const result = await pickTextFile(PROJECT_FILE);

    expect(result).toEqual({ name: 'scene.3doo', text: '{}', handle: null });
  });
});

describe('pickFolder', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'showDirectoryPicker');
  });

  /** A picked folder, with Chromium's permission calls answering as asked. */
  function stubFolder(options: { permission?: PermissionState; granted?: PermissionState } = {}) {
    return {
      name: 'Projects',
      queryPermission: () => Promise.resolve(options.permission ?? 'granted'),
      requestPermission: () => Promise.resolve(options.granted ?? 'granted'),
    };
  }

  function offer(result: object | DOMException) {
    const picker = vi.fn((_options: { startIn?: unknown; mode?: string }) =>
      result instanceof DOMException ? Promise.reject(result) : Promise.resolve(result),
    );
    Object.assign(window, { showDirectoryPicker: picker });
    return picker;
  }

  it('opens where it is told to, asking to write there', async () => {
    const folder = stubFolder();
    const picker = offer(folder);

    expect(await pickFolder('documents')).toEqual({ status: 'picked', folder });
    expect(picker).toHaveBeenCalledWith({ startIn: 'documents', mode: 'readwrite' });
  });

  it('treats a dismissed picker, or a folder the browser refused, as nothing chosen', async () => {
    // Choosing the Desktop itself gets Chrome's notice about system files, and
    // giving up there reaches the page as this same abort.
    offer(new DOMException('The user aborted a request.', 'AbortError'));

    expect(await pickFolder('documents')).toEqual({ status: 'cancelled' });
  });

  it('says why when the browser gives a folder but not the use of it', async () => {
    offer(stubFolder({ permission: 'prompt', granted: 'denied' }));

    expect(await pickFolder('documents')).toEqual({
      status: 'failed',
      reason: 'permission to write to it was not given',
    });
  });

  it('passes on any other refusal from the picker in its own words', async () => {
    offer(new DOMException('Must be handling a user gesture', 'SecurityError'));

    expect(await pickFolder('documents')).toEqual({
      status: 'failed',
      reason: 'Must be handling a user gesture',
    });
  });

  it('fails plainly where there is no folder picker at all', async () => {
    expect(canPickFolder()).toBe(false);
    expect(await pickFolder('documents')).toMatchObject({ status: 'failed' });
  });
});

describe('mayWriteNow', () => {
  it('answers from the permission as it stands, never asking', async () => {
    const requestPermission = vi.fn();
    const handle = (permission: PermissionState) =>
      ({
        queryPermission: () => Promise.resolve(permission),
        requestPermission,
      }) as unknown as FileSystemHandle;

    expect(await mayWriteNow(handle('granted'))).toBe(true);
    expect(await mayWriteNow(handle('prompt'))).toBe(false);
    // A timer has no click to answer a prompt with.
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('canWriteBack', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });

  it('is true only where a picker can hand over a file to write back to', () => {
    expect(canWriteBack()).toBe(false);

    Object.assign(window, { showSaveFilePicker: () => Promise.reject(new Error('unused')) });

    expect(canWriteBack()).toBe(true);
  });
});

describe('wrongKindMessage', () => {
  it('passes a matching suffix in any case, and names what it wanted otherwise', () => {
    expect(wrongKindMessage('scene.3DOO', PROJECT_FILE)).toBeNull();
    expect(wrongKindMessage('scene.json', PROJECT_FILE)).toBe(
      'scene.json is not a project file, expected .3doo',
    );
  });

  it('still opens the .json spelling of each kind', () => {
    // The contents are JSON whatever the name says, so a file saved before the
    // extension shortened (or renamed through a tool that only speaks JSON)
    // still opens. Saves are named with the bare extension either way.
    expect(wrongKindMessage('scene.3doo.json', PROJECT_FILE)).toBeNull();
    expect(wrongKindMessage('3doo.pref.json', PREFERENCES_FILE)).toBeNull();
    expect(wrongKindMessage('3doo.pref', PREFERENCES_FILE)).toBeNull();

    expect(PROJECT_FILE.extension).toBe('.3doo');
    expect(PREFERENCES_FILE.extension).toBe('.pref');
  });

  it('does not let one kind through the gate of the other', () => {
    expect(wrongKindMessage('3doo.pref', PROJECT_FILE)).not.toBeNull();
    expect(wrongKindMessage('scene.3doo', PREFERENCES_FILE)).not.toBeNull();
  });
});
