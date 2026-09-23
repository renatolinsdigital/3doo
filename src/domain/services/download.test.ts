import { afterEach, describe, expect, it, vi } from 'vitest';

import { PREFERENCES_FILE, PROJECT_FILE, saveTextFile, wrongKindMessage } from './download';

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
  const calls: { suggestedName?: string; extensions: string[] }[] = [];

  const picker = vi.fn((request: { suggestedName?: string; types?: { accept: object }[] }) => {
    calls.push({
      suggestedName: request.suggestedName,
      extensions: Object.values(request.types?.[0]?.accept ?? {}).flat() as string[],
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

    expect(result).toEqual({ status: 'saved', filename: 'chosen.3doo' });
    expect(written).toEqual(['{"a":1}']);
    // Only the canonical suffix is offered to save under: the .json spelling
    // is there for opening older files, not for naming new ones.
    expect(calls[0]).toEqual({ suggestedName: 'suggested.3doo', extensions: ['.3doo'] });
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
