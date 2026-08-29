import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { useProjectFiles } from './useProjectFiles';

import type { FileKind, SaveResult } from '../services/download';

const downloads: { filename: string; contents: string }[] = [];
const saves: { suggestedName: string; contents: string; kind: FileKind }[] = [];
let picked: { name: string; text: string } | null = null;
let saveResult: SaveResult = { status: 'saved', filename: 'placeholder' };

// `saveResultToast` is deliberately left real: the mapping from outcome to
// message is what these tests are checking.
vi.mock('../services/download', async () => {
  const actual =
    await vi.importActual<typeof import('../services/download')>('../services/download');
  return {
    ...actual,
    downloadText: (filename: string, contents: string) => downloads.push({ filename, contents }),
    pickTextFile: () => Promise.resolve(picked),
    saveTextFile: (suggestedName: string, contents: string, kind: FileKind) => {
      saves.push({ suggestedName, contents, kind });
      return Promise.resolve(saveResult);
    },
  };
});

function toasts() {
  return useEditorStore.getState().toasts;
}

function lastToast() {
  const all = toasts();
  return all[all.length - 1];
}

function files() {
  return renderHook(() => useProjectFiles()).result;
}

describe('project actions announce themselves', () => {
  beforeEach(() => {
    downloads.length = 0;
    saves.length = 0;
    picked = null;
    saveResult = { status: 'saved', filename: 'placeholder' };
    useEditorStore.getState().resetScene();
    useEditorStore.setState({ toasts: [] });
  });

  it('offers the project name to the save dialog, and reports where it landed', async () => {
    const project = files();
    act(() => useEditorStore.getState().setProjectName('LAMP POST'));
    saveResult = { status: 'saved', filename: 'lamp.3doo' };

    await act(() => project.current.saveProject());

    expect(saves).toHaveLength(1);
    expect(saves[0].suggestedName).toBe('LAMP POST.3doo');
    expect(saves[0].kind.extension).toBe('.3doo');
    // The dialog is where the final name is settled, so the toast reports what
    // came back from it rather than what was suggested.
    expect(lastToast()).toMatchObject({ variant: 'success', message: 'Saved lamp.3doo' });
  });

  it('only claims a downloads folder when the browser chose the destination', async () => {
    const project = files();
    act(() => useEditorStore.getState().setProjectName('CRATE'));
    saveResult = { status: 'downloaded', filename: 'CRATE.3doo' };

    await act(() => project.current.saveProject());

    expect(lastToast().message).toBe('Saved CRATE.3doo to your downloads');
  });

  it('refuses to overwrite a file that is already there', async () => {
    const project = files();
    saveResult = { status: 'exists', filename: 'taken.3doo' };

    await act(() => project.current.saveProject());

    expect(lastToast()).toMatchObject({
      variant: 'error',
      message: 'taken.3doo already exists, save under a different name',
    });
  });

  it('says nothing when the save dialog is dismissed', async () => {
    const project = files();
    saveResult = { status: 'cancelled', filename: 'untitled.3doo' };

    await act(() => project.current.saveProject());

    expect(toasts()).toHaveLength(0);
  });

  it('falls back to untitled rather than suggesting a nameless file', async () => {
    const project = files();
    act(() => useEditorStore.getState().setProjectName(''));

    await act(() => project.current.saveProject());

    expect(saves[0].suggestedName).toBe('untitled.3doo');
  });

  it('names both files an OBJ export writes, not just the mesh', () => {
    const project = files();
    act(() => {
      const state = useEditorStore.getState();
      state.setProjectName('CRATE');
      state.addPrimitive('box');
    });

    act(() => project.current.exportModel('obj'));

    expect(downloads.map((entry) => entry.filename)).toEqual(['CRATE.obj', 'CRATE.mtl']);
    // The .mtl arrives beside the .obj; a message naming only the mesh is how
    // the material file gets left behind.
    expect(lastToast().message).toBe('Saved CRATE.obj and CRATE.mtl to your downloads');
  });

  it('says why there was nothing to export', () => {
    const project = files();

    act(() => project.current.exportModel('obj'));
    expect(lastToast()).toMatchObject({ variant: 'warning' });
    expect(lastToast().message).toMatch(/empty or every object is hidden/);

    act(() => {
      useEditorStore.getState().addPrimitive('box');
      useEditorStore.setState({ selectedObjectIds: [] });
    });

    act(() => project.current.exportModel('obj', true));
    expect(lastToast().message).toBe('Nothing selected to export');
  });

  it('reports a new project instead of clearing the scene in silence', () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('box'));

    act(() => project.current.newProject());

    expect(useEditorStore.getState().objects).toHaveLength(0);
    expect(lastToast()).toMatchObject({ variant: 'info', message: 'Started a new project' });
  });

  it('names the file it opened, and the file it could not', async () => {
    const project = files();

    picked = { name: 'scene.3doo', text: '{"not":"a project"}' };
    await act(() => project.current.openProject());

    expect(lastToast()).toMatchObject({ variant: 'error' });
    expect(lastToast().message).toMatch(/^Could not open scene\.3doo: /);
  });

  it('refuses a file that is not a project, before trying to parse it', async () => {
    const project = files();

    // A valid project body, but the wrong extension: the gate is the name, so
    // the refusal names what was expected instead of reporting a parse error.
    picked = { name: 'holiday.json', text: '{}' };
    await act(() => project.current.openProject());

    expect(lastToast()).toMatchObject({
      variant: 'error',
      message: 'holiday.json is not a project file, expected .3doo',
    });
    expect(useEditorStore.getState().objects).toHaveLength(0);
  });

  it('refuses a mesh import that is not an OBJ', async () => {
    const project = files();

    picked = { name: 'chair.fbx', text: 'v 0 0 0\n' };
    await act(() => project.current.importMesh());

    expect(lastToast()).toMatchObject({
      variant: 'error',
      message: 'chair.fbx is not an OBJ mesh, expected .obj',
    });
    expect(useEditorStore.getState().objects).toHaveLength(0);
  });

  it('accepts the extension whatever its case', async () => {
    const project = files();

    picked = { name: 'CHAIR.OBJ', text: 'v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n' };
    await act(() => project.current.importMesh());

    expect(lastToast()).toMatchObject({ variant: 'success' });
  });

  it('stays quiet when the picker is dismissed', async () => {
    const project = files();

    picked = null;
    await act(() => project.current.openProject());
    await act(() => project.current.importMesh());

    expect(toasts()).toHaveLength(0);
  });

  it('names the file geometry was imported from', async () => {
    const project = files();

    picked = { name: 'chair.obj', text: 'v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n' };
    await act(() => project.current.importMesh());

    expect(lastToast()).toMatchObject({ variant: 'success' });
    expect(lastToast().message).toBe('Imported 1 object(s) from chair.obj');
  });

  it('warns by name when a file holds no geometry', async () => {
    const project = files();

    picked = { name: 'empty.obj', text: '# nothing here\n' };
    await act(() => project.current.importMesh());

    expect(lastToast()).toMatchObject({
      variant: 'warning',
      message: 'No geometry found in empty.obj',
    });
  });
});
