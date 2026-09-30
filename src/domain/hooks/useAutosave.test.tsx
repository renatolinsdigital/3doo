import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseProject } from '@kernel/index';
import { useEditorStore } from '@store/index';

import {
  allowAutosaveLocation,
  chooseAutosaveLocation,
  forgetAutosaveLocation,
  setOpeningSceneDone,
  turnAutosaveOn,
  useAutosave,
} from './useAutosave';
import { useProjectFiles } from './useProjectFiles';

/** The location the last session was writing its numbered copies to. */
let storedLocation: FileSystemDirectoryHandle | null = null;
let locationReads = 0;
/** How many times the copy an earlier build kept in the browser was cleared. */
let forgotten = 0;

// The numbered copies are left real, so what the hook writes is checked
// against what would actually land in the folder. IndexedDB is the part stood
// in for: jsdom has none, and all it holds now is the location.
vi.mock('../services/autosave', async () => {
  const actual =
    await vi.importActual<typeof import('../services/autosave')>('../services/autosave');
  return {
    ...actual,
    readAutosaveLocation: () => {
      locationReads += 1;
      return Promise.resolve(storedLocation);
    },
    writeAutosaveLocation: (location: FileSystemDirectoryHandle) => {
      storedLocation = location;
      return Promise.resolve(true);
    },
    clearAutosaveLocation: () => {
      storedLocation = null;
      return Promise.resolve(true);
    },
    forgetBrowserCopy: () => {
      forgotten += 1;
      return Promise.resolve();
    },
  };
});

/**
 * A folder on disk, as far as the autosave can tell: names to list, files to
 * write text into, and Chromium's permission calls answering as asked.
 */
function fakeFolder(
  options: {
    name?: string;
    files?: string[];
    permission?: PermissionState;
    granted?: PermissionState;
    refuseWrite?: DOMException;
    /** Keeps every write in flight until it settles. */
    holdUntil?: Promise<void>;
    child?: FileSystemDirectoryHandle;
  } = {},
) {
  const files = new Map<string, string>((options.files ?? []).map((name) => [name, '']));
  let permission = options.permission ?? 'granted';
  const requestPermission = vi.fn(() => {
    permission = options.granted ?? 'granted';
    return Promise.resolve(permission);
  });
  const getDirectoryHandle = vi.fn(() => Promise.resolve(options.child));

  const folder = {
    name: options.name ?? '3doo-auto-saves',
    kind: 'directory',
    queryPermission: () => Promise.resolve(permission),
    requestPermission,
    getDirectoryHandle,
    keys: async function* () {
      yield* [...files.keys()];
    },
    getFileHandle: (name: string) =>
      Promise.resolve({
        name,
        createWritable: async () => {
          await options.holdUntil;
          if (options.refuseWrite) throw options.refuseWrite;
          return {
            write: (contents: string) => {
              files.set(name, contents);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          };
        },
      }),
  };

  return {
    folder: folder as unknown as FileSystemDirectoryHandle,
    files,
    requestPermission,
    getDirectoryHandle,
    /** What the browser answers from here on, as a restart or the site settings would. */
    revoke: () => {
      permission = 'prompt';
    },
  };
}

/** Stands in for Chromium's folder picker, handing back `folder` or refusing with `error`. */
function offerFolder(folder: FileSystemDirectoryHandle | null, error?: DOMException) {
  const picker = vi.fn((_options: { startIn?: string; mode?: string }) =>
    error ? Promise.reject(error) : Promise.resolve(folder),
  );
  Object.assign(window, { showDirectoryPicker: picker });
  return picker;
}

/** A `.3doo` on disk that SAVE can write straight over, empty until it does. */
function fakeFile(name: string): FileSystemFileHandle {
  return {
    name,
    getFile: () => Promise.resolve({ size: 0 }),
    createWritable: () =>
      Promise.resolve({ write: () => Promise.resolve(), close: () => Promise.resolve() }),
  } as unknown as FileSystemFileHandle;
}

/**
 * Hands the project a file for SAVE to write over, as a SAVE AS would: the
 * file itself, and its name in the top bar, without which SAVE has none.
 */
function belongTo(file: FileSystemFileHandle) {
  act(() => {
    useEditorStore.getState().setProjectName(file.name.replace(/\.3doo$/, ''));
    useEditorStore.getState().setProjectFile(file);
  });
}

const objects = () => useEditorStore.getState().objects;

/** Runs one of the switch's actions inside act, and hands back its answer. */
async function run(action: () => Promise<boolean>): Promise<boolean> {
  let answer = false;
  await act(async () => {
    answer = await action();
  });
  return answer;
}

/**
 * Runs the clock on to the next tick and lets its writes land.
 *
 * A numbered copy is several awaits deep, serialising the scene and walking
 * the folder before it writes, so a single flush would read the folder before
 * anything had reached it.
 */
async function tick(ms = 60_000) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
  });
}

/**
 * A mounted autosave writing into `folder`, on a clock the test runs.
 *
 * The folder is found on mount the way a reload finds the one chosen before,
 * in a browser whose picker could hand one over: anywhere else autosave has
 * nowhere to write and turns itself off.
 */
async function writingInto(folder: FileSystemDirectoryHandle) {
  vi.useFakeTimers();
  offerFolder(null);
  storedLocation = folder;
  renderHook(() => useAutosave());
  await tick(0);
}

const lastToast = () => useEditorStore.getState().toasts.at(-1);

beforeEach(() => {
  storedLocation = null;
  locationReads = 0;
  forgotten = 0;
  setOpeningSceneDone(false);
  useEditorStore.getState().resetScene();
  useEditorStore.getState().setAutosaveLocation(null, false);
  useEditorStore.setState({ toasts: [], dialog: null });
  useEditorStore.getState().setPreferences({ autosaveEnabled: true, autosaveInterval: 60 });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'showDirectoryPicker');
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

describe('what the editor opens on', () => {
  it('puts a cube in a fresh tab, the way Blender does', async () => {
    // An empty viewport gives you nothing to try a tool against, and adding a
    // cube is the first thing anybody does with one anyway.
    renderHook(() => useAutosave());

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0].name).toBe('CUBE');
    expect(objects()[0].primitive?.kind).toBe('cube');
  });

  it('puts one there, not two, under StrictMode, which mounts the hook twice', async () => {
    renderHook(() => useAutosave(), { wrapper: StrictMode });

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0].name).toBe('CUBE');
  });

  it('opens on the cube with autosave on too: the browser keeps no session to come back to', async () => {
    offerFolder(null);
    storedLocation = fakeFolder().folder;

    renderHook(() => useAutosave());

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0].name).toBe('CUBE');
  });

  it('clears the copy an earlier build kept in this browser, once', async () => {
    renderHook(() => useAutosave(), { wrapper: StrictMode });
    await act(async () => {});

    expect(forgotten).toBe(1);
  });

  it('leaves the cube selected and ready to work on', async () => {
    renderHook(() => useAutosave());

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(useEditorStore.getState().activeObjectId).toBe(objects()[0].id);
  });

  it('is one undo away from the empty scene, for anyone who wants that', async () => {
    renderHook(() => useAutosave());
    await waitFor(() => expect(objects()).toHaveLength(1));

    act(() => useEditorStore.getState().undo());

    expect(objects()).toHaveLength(0);
  });

  it('does not put the cube back once the scene has been emptied', async () => {
    // Walking to DOCS and back remounts the hook, and an empty scene by then
    // is one the user emptied on purpose.
    const first = renderHook(() => useAutosave());
    await waitFor(() => expect(objects()).toHaveLength(1));

    act(() => useEditorStore.getState().resetScene());
    first.unmount();
    renderHook(() => useAutosave());
    await act(async () => {});

    expect(objects()).toHaveLength(0);
  });

  it('leaves a scene that is already there alone', async () => {
    act(() => useEditorStore.getState().addPrimitive('torus'));

    renderHook(() => useAutosave());
    await act(async () => {});

    expect(objects()).toHaveLength(1);
    expect(objects()[0].name).toBe('TORUS');
  });
});

describe('what the timer writes', () => {
  it('writes nothing while the tab sits untouched', async () => {
    // The opening cube is the editor's doing. A tab opened, looked at and left
    // alone has nothing anybody would want back.
    const { folder, files } = fakeFolder();
    await writingInto(folder);
    expect(objects()).toHaveLength(1);

    await tick(300_000);

    expect(files.size).toBe(0);
    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it('writes on the interval once something has changed, then stops again', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);

    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();
    expect(files.size).toBe(1);

    // Same scene, three ticks later: the first copy is still the current one.
    await tick(180_000);
    expect(files.size).toBe(1);
  });

  it('raises no toast for a copy that lands, leaving the disk to say it', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);

    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();

    expect(files.size).toBe(1);
    expect(useEditorStore.getState().toasts).toHaveLength(0);
  });

  it('writes nothing for an edit taken back with Ctrl+Z', async () => {
    // Touched is not changed: the undo lands on the scene already written, and
    // writing it again would only store a copy of itself.
    const { folder, files } = fakeFolder();
    await writingInto(folder);
    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();
    expect(files.size).toBe(1);

    act(() => useEditorStore.getState().addPrimitive('cone'));
    act(() => useEditorStore.getState().undo());
    expect(useEditorStore.getState().dirty).toBe(true);
    await tick();

    expect(files.size).toBe(1);
    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it('still writes the scene an undo goes back to, when that is not the one stored', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);
    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();

    act(() => useEditorStore.getState().undo());
    await tick();

    expect(files.size).toBe(2);
    const second = parseProject(files.get('untitled_02.3doo') ?? '');
    expect(second.objects.map((object) => object.name)).toEqual(['CUBE']);
  });

  it('writes nothing for a folder folded shut in the outliner', async () => {
    // Folding is how the outliner looks, and a file does not hold it.
    const { folder, files } = fakeFolder();
    await writingInto(folder);
    act(() => useEditorStore.getState().groupSelected());
    await tick();
    expect(files.size).toBe(1);

    const [group] = useEditorStore.getState().groups;
    act(() => useEditorStore.getState().toggleGroupCollapsed(group.id));
    await tick();

    expect(files.size).toBe(1);
  });

  it('counts a rename as a change, though it moves no geometry', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);

    const id = objects()[0].id;
    act(() => useEditorStore.getState().renameObject(id, 'LAMP POST'));
    await tick();

    expect(files.size).toBe(1);
  });

  it('notes a landed copy, so the status bar can turn its disk', async () => {
    const { folder } = fakeFolder();
    await writingInto(folder);
    const before = useEditorStore.getState().autosaveToken;

    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();

    expect(useEditorStore.getState().autosaveToken).toBe(before + 1);
  });

  it('says so when a copy does not land, and tries again on the next tick', async () => {
    // The disk says the work reached a file. A copy that did not land must not
    // claim it, or the one moment the reassurance matters is the one moment it
    // lies.
    const { folder } = fakeFolder({
      refuseWrite: new DOMException('The folder is gone', 'NotFoundError'),
    });
    await writingInto(folder);
    const before = useEditorStore.getState().autosaveToken;

    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();

    expect(lastToast()).toMatchObject({
      variant: 'warning',
      message: 'Could not write the auto-save to 3doo-auto-saves: The folder is gone',
    });
    expect(useEditorStore.getState().autosaveToken).toBe(before);
    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('leaves nothing to retry when a SAVE lands while a failing copy is in flight', async () => {
    let fail = () => {};
    const holdUntil = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const { folder, files } = fakeFolder({
      holdUntil,
      refuseWrite: new DOMException('The disk is full', 'QuotaExceededError'),
    });
    await writingInto(folder);
    const project = renderHook(() => useProjectFiles()).result;
    belongTo(fakeFile('lamp.3doo'));

    act(() => useEditorStore.getState().addPrimitive('torus'));
    act(() => vi.advanceTimersByTime(60_000));
    act(() => useEditorStore.getState().addPrimitive('cone'));
    await act(() => project.current.saveProject());
    fail();
    await tick(0);

    // The file holds everything the failed copy would have, and the cone on
    // top, so the next tick has nothing to put right.
    expect(useEditorStore.getState().dirty).toBe(false);
    await tick();
    expect(files.size).toBe(0);
  });

  it('stops writing when autosave is turned off', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);

    act(() => useEditorStore.getState().setPreferences({ autosaveEnabled: false }));
    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();

    expect(files.size).toBe(0);
  });

  it('writes on the interval the preferences ask for', async () => {
    act(() => useEditorStore.getState().setPreferences({ autosaveInterval: 300 }));
    const { folder, files } = fakeFolder();
    await writingInto(folder);
    act(() => useEditorStore.getState().addPrimitive('torus'));

    await tick(60_000);
    expect(files.size).toBe(0);

    await tick(240_000);
    expect(files.size).toBe(1);
  });
});

describe('numbered copies in the autosave folder', () => {
  it('writes the next numbered copy into the folder on the tick', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);

    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();

    // A project nobody has named yet is the top bar's own default.
    expect([...files.keys()]).toEqual(['untitled_01.3doo']);
  });

  it('names the copies after the project name before there is a file', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);

    act(() => useEditorStore.getState().setProjectName('LAMP POST'));
    await tick();

    expect([...files.keys()]).toEqual(['LAMP POST_01.3doo']);
  });

  it('names them after the .3doo once there is one', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);

    act(() => useEditorStore.getState().setProjectName('SOMETHING ELSE'));
    act(() => useEditorStore.getState().setProjectFile(fakeFile('lamp.3doo')));
    await tick();

    // The file is what the user sees on disk, so its copies read as its own.
    expect([...files.keys()]).toEqual(['lamp_01.3doo']);
  });

  it('numbers the copies after the file SAVE AS just wrote', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);
    Object.assign(window, { showSaveFilePicker: () => Promise.resolve(fakeFile('cone.3doo')) });
    const project = renderHook(() => useProjectFiles()).result;

    act(() => useEditorStore.getState().addPrimitive('cone'));
    await act(() => project.current.saveProjectAs());
    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();
    act(() => useEditorStore.getState().addPrimitive('plane'));
    await tick();

    expect([...files.keys()]).toEqual(['cone_01.3doo', 'cone_02.3doo']);
  });

  it('carries on from the highest copy already there, whatever its case', async () => {
    // Yesterday's copies are still in the folder. Windows reads LAMP_07 and
    // lamp_07 as one file, so both spellings count towards the next number.
    const { folder, files } = fakeFolder({
      files: ['lamp_03.3doo', 'LAMP_07.3doo', 'lamp.3doo', 'other_09.3doo'],
    });
    await writingInto(folder);

    act(() => useEditorStore.getState().setProjectFile(fakeFile('lamp.3doo')));
    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();

    expect(files.has('lamp_08.3doo')).toBe(true);
    expect(files.size).toBe(5);
  });

  it('adds a copy each time rather than writing over the last', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);

    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();
    act(() => useEditorStore.getState().addPrimitive('cone'));
    await tick();

    expect([...files.keys()]).toEqual(['untitled_01.3doo', 'untitled_02.3doo']);
    expect(parseProject(files.get('untitled_01.3doo') ?? '').objects).toHaveLength(2);
    expect(parseProject(files.get('untitled_02.3doo') ?? '').objects).toHaveLength(3);
  });

  it('writes a whole .3doo, the one SAVE would have written', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);

    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();

    // Opens on its own, like a saved file: the scene, and nothing of the
    // route taken to it.
    const copy = files.get('untitled_01.3doo') ?? '';
    expect(parseProject(copy).objects.map((object) => object.name)).toEqual(['CUBE', 'TORUS']);
    expect(Object.keys(JSON.parse(copy))).not.toContain('history');
  });

  it('writes no copy of a scene SAVE has just written, however it is touched', async () => {
    const { folder, files } = fakeFolder();
    await writingInto(folder);
    const project = renderHook(() => useProjectFiles()).result;
    belongTo(fakeFile('lamp.3doo'));
    act(() => useEditorStore.getState().addPrimitive('torus'));
    await act(() => project.current.saveProject());

    // Picking faces rather than vertices changes how the mesh is looked at,
    // not the mesh, though it bumps the geometry counter the flag watches.
    act(() => useEditorStore.getState().setSelectMode('face'));
    expect(useEditorStore.getState().dirty).toBe(true);
    await tick();

    expect(files.size).toBe(0);
  });

  it('writes nothing while the folder waits to be allowed, and catches up once it is', async () => {
    const { folder, files } = fakeFolder({ permission: 'prompt' });
    await writingInto(folder);
    expect(useEditorStore.getState().autosaveLocationReady).toBe(false);

    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();
    expect(files.size).toBe(0);

    expect(await run(allowAutosaveLocation)).toBe(true);
    await tick();

    // The change made while it waited is the one written.
    expect([...files.keys()]).toEqual(['untitled_01.3doo']);
  });

  it('stops writing there when the browser takes the permission back', async () => {
    const { folder, files, revoke } = fakeFolder();
    await writingInto(folder);
    revoke();

    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();

    // Asking again takes a click, so the folder waits for one, and PREFS says
    // what it is waiting for, instead of a warning on every tick.
    expect(files.size).toBe(0);
    expect(useEditorStore.getState().autosaveLocationReady).toBe(false);
    expect(useEditorStore.getState().autosaveLocation).toBe(folder);
    expect(useEditorStore.getState().toasts).toHaveLength(0);
    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('writes into a 3doo-auto-saves made inside any other location', async () => {
    const inside = fakeFolder();
    const { folder: projects, getDirectoryHandle } = fakeFolder({
      name: 'Projects',
      child: inside.folder,
    });
    await writingInto(projects);

    act(() => useEditorStore.getState().addPrimitive('torus'));
    await tick();

    // Asked for at every write, so a folder deleted between two ticks is made
    // again rather than written past.
    expect(getDirectoryHandle).toHaveBeenCalledWith('3doo-auto-saves', { create: true });
    expect([...inside.files.keys()]).toEqual(['untitled_01.3doo']);
  });
});

describe('the autosave location when the editor opens', () => {
  it('finds it again, saying nothing, when the browser kept the permission', async () => {
    offerFolder(null);
    const { folder } = fakeFolder();
    storedLocation = folder;

    renderHook(() => useAutosave());

    await waitFor(() => expect(useEditorStore.getState().autosaveLocation).toBe(folder));
    expect(useEditorStore.getState().autosaveLocationReady).toBe(true);
    expect(useEditorStore.getState().dialog).toBeNull();
  });

  it('asks again when a restart has taken the permission away', async () => {
    offerFolder(null);
    const { folder } = fakeFolder({ permission: 'prompt' });
    storedLocation = folder;

    renderHook(() => useAutosave());

    await waitFor(() => expect(useEditorStore.getState().dialog).toBe('autosaveLocation'));
    expect(useEditorStore.getState().autosaveLocation).toBe(folder);
    expect(useEditorStore.getState().autosaveLocationReady).toBe(false);
  });

  it('turns autosave off when it is on with nowhere to write', async () => {
    // How a preference saved by a build that kept every copy in the browser
    // arrives. Autosave starts off until somebody says where it goes.
    offerFolder(null);

    renderHook(() => useAutosave());

    await waitFor(() => expect(useEditorStore.getState().autosaveEnabled).toBe(false));
    expect(useEditorStore.getState().dialog).toBeNull();
  });

  it('shows the location while autosave is off, asking nothing', async () => {
    // PREFS names it either way: it is a setting, and turning autosave on
    // later uses it rather than asking again.
    offerFolder(null);
    const { folder } = fakeFolder({ permission: 'prompt' });
    storedLocation = folder;
    act(() => useEditorStore.getState().setPreferences({ autosaveEnabled: false }));

    renderHook(() => useAutosave());

    await waitFor(() => expect(useEditorStore.getState().autosaveLocation).toBe(folder));
    expect(useEditorStore.getState().dialog).toBeNull();
    expect(useEditorStore.getState().autosaveEnabled).toBe(false);
  });

  it('turns autosave off, asking nothing, in a browser that cannot hand over a folder', async () => {
    // Auto-saves only go into a folder, so on here it would write nowhere.
    renderHook(() => useAutosave());
    await waitFor(() => expect(objects()).toHaveLength(1));

    expect(locationReads).toBe(0);
    expect(useEditorStore.getState().dialog).toBeNull();
    expect(useEditorStore.getState().autosaveEnabled).toBe(false);
  });
});

describe('turning autosave on and off', () => {
  beforeEach(() => {
    act(() => useEditorStore.getState().setPreferences({ autosaveEnabled: false }));
  });

  it('asks for a location when there is none, starting in Documents', async () => {
    const { folder } = fakeFolder();
    const picker = offerFolder(folder);

    expect(await run(turnAutosaveOn)).toBe(true);

    expect(picker).toHaveBeenCalledWith({ startIn: 'documents', mode: 'readwrite' });
    const state = useEditorStore.getState();
    expect(state.autosaveEnabled).toBe(true);
    expect(state.autosaveLocation).toBe(folder);
    expect(state.autosaveLocationReady).toBe(true);
    // Kept for the next visit, which then only has to ask for permission.
    expect(storedLocation).toBe(folder);
    expect(state.toasts.at(-1)).toMatchObject({
      variant: 'success',
      message: 'Autosave is on, writing to 3doo-auto-saves',
    });
  });

  it('makes 3doo-auto-saves inside any other location, there and then', async () => {
    const inside = fakeFolder().folder;
    const { folder, getDirectoryHandle } = fakeFolder({ name: 'Projects', child: inside });
    offerFolder(folder);

    await run(turnAutosaveOn);

    // Made while the user is still choosing, so a location that cannot take
    // it says so then rather than at the first tick.
    expect(getDirectoryHandle).toHaveBeenCalledWith('3doo-auto-saves', { create: true });
    expect(useEditorStore.getState().autosaveLocation).toBe(folder);
    expect(useEditorStore.getState().toasts.at(-1)?.message).toBe(
      'Autosave is on, writing to Projects/3doo-auto-saves',
    );
  });

  it('stays off when the picker is dismissed', async () => {
    offerFolder(null, new DOMException('The user aborted a request.', 'AbortError'));

    expect(await run(turnAutosaveOn)).toBe(false);

    expect(useEditorStore.getState().autosaveEnabled).toBe(false);
    expect(useEditorStore.getState().toasts).toHaveLength(0);
  });

  it('stays off, and says why, when the folder cannot be written to', async () => {
    const { folder } = fakeFolder({ permission: 'prompt', granted: 'denied' });
    offerFolder(folder);

    expect(await run(turnAutosaveOn)).toBe(false);

    expect(useEditorStore.getState().autosaveEnabled).toBe(false);
    expect(useEditorStore.getState().toasts.at(-1)).toMatchObject({
      variant: 'error',
      message: 'Could not use that folder for autosave: permission to write to it was not given',
    });
  });

  it('stays off, and says why, where there is no folder to be had', async () => {
    expect(await run(turnAutosaveOn)).toBe(false);

    expect(useEditorStore.getState().autosaveEnabled).toBe(false);
    expect(useEditorStore.getState().toasts.at(-1)).toMatchObject({
      variant: 'warning',
      message: 'Autosave writes to a folder, which this browser cannot give it',
    });
  });

  it('keeps the location through off and on, asking for it only once', async () => {
    const { folder } = fakeFolder();
    const picker = offerFolder(folder);
    await run(turnAutosaveOn);

    act(() => useEditorStore.getState().setPreferences({ autosaveEnabled: false }));
    expect(useEditorStore.getState().autosaveLocation).toBe(folder);

    expect(await run(turnAutosaveOn)).toBe(true);
    expect(picker).toHaveBeenCalledTimes(1);
  });

  it('asks back a lapsed permission rather than a new location', async () => {
    const { folder, requestPermission } = fakeFolder({ permission: 'prompt' });
    const picker = offerFolder(null);
    act(() => useEditorStore.getState().setAutosaveLocation(folder, false));

    expect(await run(turnAutosaveOn)).toBe(true);

    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(picker).not.toHaveBeenCalled();
    expect(useEditorStore.getState().autosaveLocationReady).toBe(true);
  });

  it('stays off when that permission is refused', async () => {
    const { folder } = fakeFolder({ permission: 'prompt', granted: 'denied' });
    offerFolder(null);
    act(() => useEditorStore.getState().setAutosaveLocation(folder, false));

    expect(await run(turnAutosaveOn)).toBe(false);

    expect(useEditorStore.getState().autosaveEnabled).toBe(false);
  });

  it('changes the location from PREFS without turning autosave on', async () => {
    const { folder } = fakeFolder({ name: 'Projects', child: fakeFolder().folder });
    offerFolder(folder);

    expect(await run(chooseAutosaveLocation)).toBe(true);

    expect(useEditorStore.getState().autosaveLocation).toBe(folder);
    expect(useEditorStore.getState().autosaveEnabled).toBe(false);
    expect(useEditorStore.getState().toasts.at(-1)?.message).toBe(
      'Auto-saves go to Projects/3doo-auto-saves',
    );
  });

  it('forgets the location for RESET, here and in the next session', async () => {
    const { folder } = fakeFolder({ name: 'Projects', child: fakeFolder().folder });
    offerFolder(folder);
    await run(chooseAutosaveLocation);

    await act(() => forgetAutosaveLocation());

    expect(useEditorStore.getState().autosaveLocation).toBeNull();
    expect(useEditorStore.getState().autosaveLocationReady).toBe(false);
    expect(storedLocation).toBeNull();
  });

  it('opens the picker where the current location is', async () => {
    const current = fakeFolder().folder;
    const picker = offerFolder(fakeFolder().folder);
    act(() => useEditorStore.getState().setAutosaveLocation(current, true));

    await run(chooseAutosaveLocation);

    expect(picker).toHaveBeenCalledWith({ startIn: current, mode: 'readwrite' });
  });

  it('asks the browser again for the location it already has', async () => {
    const { folder, requestPermission } = fakeFolder({ permission: 'prompt' });
    act(() => useEditorStore.getState().setAutosaveLocation(folder, false));

    expect(await run(allowAutosaveLocation)).toBe(true);

    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(useEditorStore.getState().autosaveLocationReady).toBe(true);
  });

  it('leaves it waiting when the browser is refused', async () => {
    const { folder } = fakeFolder({ permission: 'prompt', granted: 'denied' });
    act(() => useEditorStore.getState().setAutosaveLocation(folder, false));

    expect(await run(allowAutosaveLocation)).toBe(false);

    expect(useEditorStore.getState().autosaveLocationReady).toBe(false);
    expect(useEditorStore.getState().toasts.at(-1)).toMatchObject({ variant: 'warning' });
  });
});
