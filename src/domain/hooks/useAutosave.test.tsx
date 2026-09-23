import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistorySnapshot, ProjectDocument } from '@kernel/index';
import { useEditorStore } from '@store/index';

import { setOpeningSceneDone, useAutosave } from './useAutosave';

interface Record {
  document: ProjectDocument;
  savedAt: string;
  history?: HistorySnapshot;
}

let record: Record | null = null;
let reads = 0;
let writes = 0;
let written: Record | null = null;

// `storableHistory` is left real, so what the hook hands over is checked
// against what would actually be stored.
vi.mock('../services/autosave', async () => {
  const actual =
    await vi.importActual<typeof import('../services/autosave')>('../services/autosave');
  return {
    readAutosave: () => {
      reads += 1;
      return Promise.resolve(record);
    },
    writeAutosave: (document: ProjectDocument, history?: HistorySnapshot) => {
      writes += 1;
      written = {
        document,
        savedAt: new Date().toISOString(),
        history: history && actual.storableHistory(history),
      };
      return Promise.resolve(true);
    },
  };
});

const objects = () => useEditorStore.getState().objects;

/** A saved session holding one named object, to come back to. */
function sessionWith(kind: 'cone' | 'torus'): Record {
  useEditorStore.getState().resetScene();
  useEditorStore.getState().addPrimitive(kind);
  const state = useEditorStore.getState();
  const session = {
    document: state.snapshotDocument(),
    savedAt: new Date().toISOString(),
    history: state.snapshotHistory(),
  };
  useEditorStore.getState().resetScene();
  return session;
}

describe('what the editor opens on', () => {
  beforeEach(() => {
    record = null;
    reads = 0;
    writes = 0;
    written = null;
    setOpeningSceneDone(false);
    useEditorStore.getState().resetScene();
    useEditorStore.getState().setPreferences({ autosaveEnabled: true, autosaveInterval: 30 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('puts a cube in a fresh tab, the way Blender does', async () => {
    // An empty viewport gives you nothing to try a tool against, and adding a
    // cube is the first thing anybody does with one anyway.
    renderHook(() => useAutosave());

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0].name).toBe('CUBE');
    expect(objects()[0].primitive?.kind).toBe('cube');
  });

  it('still puts it there under StrictMode, which mounts the hook twice', async () => {
    // The double mount is what the dev server does on every load: a guard that
    // lived on the mount would let the first mount claim the read and the
    // second find it claimed, and the tab would open on nothing.
    renderHook(() => useAutosave(), { wrapper: StrictMode });

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0].name).toBe('CUBE');
  });

  it('recovers the last session once, not twice, under StrictMode', async () => {
    record = sessionWith('cone');
    setOpeningSceneDone(false);

    renderHook(() => useAutosave(), { wrapper: StrictMode });

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0].name).toBe('CONE');
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

  it('comes back to the last session instead, when there is one', async () => {
    // The cube is what an empty tab opens on, not something laid over the work
    // someone is returning to.
    record = sessionWith('cone');
    setOpeningSceneDone(false);

    renderHook(() => useAutosave());

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0].name).toBe('CONE');
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

  it('opens on the cube rather than the last session when autosave is off', async () => {
    // Handing back work saved before the switch was flipped is the surprise the
    // switch is there to prevent, so the storage is not even read.
    record = sessionWith('cone');
    setOpeningSceneDone(false);
    act(() => useEditorStore.getState().setPreferences({ autosaveEnabled: false }));

    renderHook(() => useAutosave());

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0].name).toBe('CUBE');
    expect(reads).toBe(0);
  });

  it('writes nothing while the tab sits untouched', async () => {
    // The opening cube is the editor's doing. A tab opened, looked at and left
    // alone has nothing anybody would want back.
    vi.useFakeTimers();
    renderHook(() => useAutosave());
    await act(async () => {});
    expect(objects()).toHaveLength(1);

    act(() => vi.advanceTimersByTime(120_000));

    expect(writes).toBe(0);
    expect(useEditorStore.getState().dirty).toBe(false);
  });

  it('writes on the interval once something has changed, then stops again', async () => {
    // The clock is faked before the hook mounts, because the interval it sets
    // up on mount is the one being advanced.
    vi.useFakeTimers();
    renderHook(() => useAutosave());
    await act(async () => {});

    act(() => useEditorStore.getState().addPrimitive('torus'));
    act(() => vi.advanceTimersByTime(30_000));
    expect(writes).toBe(1);

    // Same scene, three ticks later: the first write is still the current one.
    act(() => vi.advanceTimersByTime(90_000));
    expect(writes).toBe(1);
  });

  it('writes the undo timeline beside the scene', async () => {
    vi.useFakeTimers();
    renderHook(() => useAutosave());
    await act(async () => {});

    act(() => useEditorStore.getState().addPrimitive('torus'));
    act(() => useEditorStore.getState().addPrimitive('cone'));
    act(() => vi.advanceTimersByTime(30_000));

    // The two adds, and the cube the tab opened on before them.
    expect(written?.history?.past.map((entry) => entry.label)).toEqual([
      'Add CUBE',
      'Add TORUS',
      'Add CONE',
    ]);
  });

  it('keeps the redo half too, so a reload lands where the tab did', async () => {
    vi.useFakeTimers();
    renderHook(() => useAutosave());
    await act(async () => {});

    act(() => useEditorStore.getState().addPrimitive('torus'));
    act(() => useEditorStore.getState().undo());
    act(() => vi.advanceTimersByTime(30_000));

    expect(written?.history?.future.map((entry) => entry.label)).toEqual(['Add TORUS']);
  });

  it('hands the recovered session its undo timeline back', async () => {
    record = sessionWith('cone');
    setOpeningSceneDone(false);

    renderHook(() => useAutosave());
    await waitFor(() => expect(objects()).toHaveLength(1));

    // The steps the last tab took are still there to take back, which is the
    // whole point of keeping them: a crash costs the work, not the way out of
    // the mistake that came before it.
    expect(useEditorStore.getState().canUndo).toBe(true);
    act(() => useEditorStore.getState().undo());
    expect(objects()).toHaveLength(0);
  });

  it('opens a record written before timelines were kept, with an empty one', async () => {
    const session = sessionWith('cone');
    record = { document: session.document, savedAt: session.savedAt };
    setOpeningSceneDone(false);

    renderHook(() => useAutosave());

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0].name).toBe('CONE');
    expect(useEditorStore.getState().canUndo).toBe(false);
  });

  it('counts a rename as a change, though it moves no geometry', async () => {
    vi.useFakeTimers();
    renderHook(() => useAutosave());
    await act(async () => {});

    const id = objects()[0].id;
    act(() => useEditorStore.getState().renameObject(id, 'LAMP POST'));
    act(() => vi.advanceTimersByTime(30_000));

    expect(writes).toBe(1);
  });

  it('stops writing when autosave is turned off', async () => {
    vi.useFakeTimers();
    renderHook(() => useAutosave());
    await act(async () => {});

    act(() => useEditorStore.getState().setPreferences({ autosaveEnabled: false }));
    act(() => useEditorStore.getState().addPrimitive('torus'));
    act(() => vi.advanceTimersByTime(30_000));

    expect(writes).toBe(0);
  });

  it('writes on the interval the preferences ask for', async () => {
    act(() => useEditorStore.getState().setPreferences({ autosaveInterval: 300 }));
    vi.useFakeTimers();
    const view = renderHook(() => useAutosave());
    await act(async () => {});
    act(() => useEditorStore.getState().addPrimitive('torus'));

    act(() => vi.advanceTimersByTime(60_000));
    expect(writes).toBe(0);

    act(() => vi.advanceTimersByTime(240_000));
    expect(writes).toBe(1);

    view.unmount();
  });

  it('does not write a recovered session straight back out', async () => {
    record = sessionWith('cone');
    setOpeningSceneDone(false);
    vi.useFakeTimers();
    renderHook(() => useAutosave());
    await act(async () => {});
    expect(objects()[0].name).toBe('CONE');

    act(() => vi.advanceTimersByTime(120_000));

    expect(writes).toBe(0);
  });

  it('says which picture it could not find when the session comes back', async () => {
    // The document names its images and OPFS holds the bytes; a browser that
    // cleared the one and not the other leaves an object pointing at nothing.
    record = sessionWith('cone');
    record.document.assets = [
      { id: 'asset-1', name: 'ref.png', type: 'image/png', width: 8, height: 8 },
    ];
    setOpeningSceneDone(false);

    renderHook(() => useAutosave());

    await waitFor(() => expect(objects()).toHaveLength(1));
    await waitFor(() =>
      expect(useEditorStore.getState().toasts.at(-1)).toMatchObject({
        variant: 'warning',
        message: 'Could not find the file for ref.png',
      }),
    );
  });

  it('leaves a scene that is already there alone', async () => {
    // Whatever resolved first wins: the opening cube never lands on top of
    // objects that are already on the table.
    act(() => useEditorStore.getState().addPrimitive('torus'));

    renderHook(() => useAutosave());
    await act(async () => {});

    expect(objects()).toHaveLength(1);
    expect(objects()[0].name).toBe('TORUS');
  });
});
