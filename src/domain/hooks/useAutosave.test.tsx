import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectDocument } from '@kernel/index';
import { useEditorStore } from '@store/index';

import { setOpeningSceneDone, useAutosave } from './useAutosave';

let record: { document: ProjectDocument; savedAt: string } | null = null;

vi.mock('../services/autosave', () => ({
  readAutosave: () => Promise.resolve(record),
  writeAutosave: () => Promise.resolve(),
}));

const objects = () => useEditorStore.getState().objects;

/** A saved session holding one named object, to come back to. */
function sessionWith(kind: 'cone' | 'torus'): { document: ProjectDocument; savedAt: string } {
  useEditorStore.getState().resetScene();
  useEditorStore.getState().addPrimitive(kind);
  const document = useEditorStore.getState().snapshotDocument();
  useEditorStore.getState().resetScene();
  return { document, savedAt: new Date().toISOString() };
}

describe('what the editor opens on', () => {
  beforeEach(() => {
    record = null;
    setOpeningSceneDone(false);
    useEditorStore.getState().resetScene();
  });

  it('puts a cube in a fresh tab, the way Blender does', async () => {
    // An empty viewport gives you nothing to try a tool against, and adding a
    // cube is the first thing anybody does with one anyway.
    renderHook(() => useAutosave());

    await waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0].name).toBe('CUBE');
    expect(objects()[0].primitive?.kind).toBe('cube');
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
