import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { useProjectFiles } from './useProjectFiles';

import type { FileKind, SaveResult } from '../services/download';

const downloads: { filename: string; contents: string }[] = [];
const saves: { suggestedName: string; contents: string; kind: FileKind }[] = [];
let picked: { name: string; text: string } | null = null;
let pickedFile: File | null = null;
let pixels = { width: 800, height: 400 };
const written: string[] = [];
const stored: string[] = [];
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
    pickFile: () => Promise.resolve(pickedFile),
    saveTextFile: (suggestedName: string, contents: string, kind: FileKind) => {
      saves.push({ suggestedName, contents, kind });
      return Promise.resolve(saveResult);
    },
  };
});

// The OPFS half is stubbed: jsdom has neither a storage directory nor an image
// decoder. Everything else in the service, including the base64 a file save
// runs on, is the real thing.
vi.mock('../services/assets', async () => {
  const actual = await vi.importActual<typeof import('../services/assets')>('../services/assets');
  return {
    ...actual,
    imageDimensions: () => Promise.resolve(pixels),
    writeAsset: (id: string) => {
      written.push(id);
      return Promise.resolve(true);
    },
    readAsset: () => Promise.resolve(null),
    clearAssets: () => Promise.resolve(),
  };
});

// jsdom has no IndexedDB, so the real service would answer "no autosave" to
// everything. What these tests are about is which call the hook makes, so the
// two writes are recorded in the order they land.
vi.mock('../services/autosave', async () => {
  const actual =
    await vi.importActual<typeof import('../services/autosave')>('../services/autosave');
  return {
    ...actual,
    writeAutosave: () => {
      stored.push('write');
      return Promise.resolve(true);
    },
    clearAutosave: () => {
      stored.push('clear');
      return Promise.resolve(true);
    },
  };
});

function imageFile(name = 'ref.png', type = 'image/png') {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

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
    pickedFile = null;
    pixels = { width: 800, height: 400 };
    written.length = 0;
    stored.length = 0;
    saveResult = { status: 'saved', filename: 'placeholder' };
    useEditorStore.setState({ autosaveEnabled: true });
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

  it('counts the project as saved once the file is on disk', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('cube'));
    expect(useEditorStore.getState().dirty).toBe(true);
    saveResult = { status: 'saved', filename: 'crate.3doo' };

    await act(() => project.current.saveProject());

    // Nothing is pending against a scene that was just written out, and there
    // is now a file holding it, so FILE > NEW has nothing left to warn about.
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(useEditorStore.getState().savedToFile).toBe(true);
  });

  it('leaves the work pending when no file was written', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('cube'));
    saveResult = { status: 'exists', filename: 'taken.3doo' };

    await act(() => project.current.saveProject());

    expect(useEditorStore.getState().dirty).toBe(true);
    expect(useEditorStore.getState().savedToFile).toBe(false);
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
      state.addPrimitive('cube');
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
      useEditorStore.getState().addPrimitive('cube');
      useEditorStore.setState({ selectedObjectIds: [] });
    });

    act(() => project.current.exportModel('obj', true));
    expect(lastToast().message).toBe('Nothing selected to export');
  });

  it('reports a new project instead of clearing the scene in silence', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('torus'));

    await act(() => project.current.newProject());

    expect(lastToast()).toMatchObject({ variant: 'info', message: 'Started a new project' });
    expect(useEditorStore.getState().status).toBe('New project');
  });

  it('starts the new project on a cube, the way Blender does', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('torus'));

    await act(() => project.current.newProject());

    const state = useEditorStore.getState();
    expect(state.objects).toHaveLength(1);
    expect(state.objects[0].name).toBe('CUBE');
    expect(state.activeObjectId).toBe(state.objects[0].id);
  });

  it('leaves that cube one undo from an empty scene', async () => {
    const project = files();

    await act(() => project.current.newProject());
    act(() => useEditorStore.getState().undo());

    expect(useEditorStore.getState().objects).toHaveLength(0);
  });

  it('takes the stored project with it, timeline and all', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('torus'));

    await act(() => project.current.newProject());

    // The reset empties the timeline in memory. Left in storage, the record
    // would hand a tab reloaded before the next tick the project that was
    // just discarded.
    expect(stored).toEqual(['clear']);
  });

  it('imports an image as a plane at the world origin', async () => {
    const project = files();
    pickedFile = imageFile();

    await act(() => project.current.importImage());

    const state = useEditorStore.getState();
    expect(state.objects).toHaveLength(1);
    expect(state.objects[0].name).toBe('REF.PNG');
    expect(state.objects[0].transform.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(lastToast()).toMatchObject({
      variant: 'success',
      message: 'Imported ref.png (800 by 400)',
    });
  });

  it('refuses a file that is not one of the formats it reads', async () => {
    const project = files();
    pickedFile = imageFile('drawing.tiff', 'image/tiff');

    await act(() => project.current.importImage());

    expect(useEditorStore.getState().objects).toHaveLength(0);
    expect(lastToast()).toMatchObject({ variant: 'error' });
    expect(lastToast().message).toMatch(/drawing.tiff is not a PNG, JPG or BMP image/);
  });

  it('keeps the bytes in the browser only while autosave is on', async () => {
    const project = files();
    pickedFile = imageFile();
    act(() => useEditorStore.getState().setPreferences({ autosaveEnabled: false }));

    await act(() => project.current.importImage());
    expect(written).toHaveLength(0);

    act(() => useEditorStore.getState().setPreferences({ autosaveEnabled: true }));
    pickedFile = imageFile('second.png');
    await act(() => project.current.importImage());

    expect(written).toHaveLength(1);
  });

  it('writes the image into the .3doo, so the file stands on its own', async () => {
    const project = files();
    pickedFile = imageFile();
    await act(() => project.current.importImage());

    await act(() => project.current.saveProject());

    const saved = JSON.parse(saves[saves.length - 1].contents);
    expect(saved.assets).toHaveLength(1);
    expect(saved.assets[0]).toMatchObject({ name: 'ref.png', type: 'image/png', width: 800 });
    // Four bytes of base64: what the browser holds is what the file gets.
    expect(saved.assets[0].data).toBe('AQIDBA==');
    expect(saved.objects[0].image).toEqual({ assetId: saved.assets[0].id });
  });

  it('reads that image back out of the file, bytes and all', async () => {
    const project = files();
    pickedFile = imageFile();
    await act(() => project.current.importImage());
    await act(() => project.current.saveProject());
    const written3doo = saves[saves.length - 1].contents;

    act(() => useEditorStore.getState().resetScene());
    picked = { name: 'scene.3doo', text: written3doo };
    await act(() => project.current.openProject());

    const state = useEditorStore.getState();
    const assetId = state.objects[0].image?.assetId ?? '';
    expect(state.objects[0].name).toBe('REF.PNG');
    expect(state.assets[assetId].name).toBe('ref.png');
    expect(state.assets[assetId].blob?.size).toBe(4);
  });

  it('leaves the undo timeline out of the file', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('cube'));
    act(() => useEditorStore.getState().addPrimitive('torus'));
    expect(useEditorStore.getState().canUndo).toBe(true);

    await act(() => project.current.saveProject());

    // A .3doo is the scene, not the route taken to it. The steps are kept in
    // the browser instead, where a reloaded tab can carry on undoing.
    const written = saves[saves.length - 1].contents;
    expect(written).not.toContain('history');
    expect(Object.keys(JSON.parse(written))).not.toContain('history');
  });

  it('opens a file without inheriting the timeline of the session that wrote it', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('cube'));
    await act(() => project.current.saveProject());
    picked = { name: 'scene.3doo', text: saves[saves.length - 1].contents };
    act(() => useEditorStore.getState().resetScene());

    await act(() => project.current.openProject());

    // Nothing in the file to inherit: the scene arrives, the steps behind it
    // stayed in the browser that made them.
    expect(useEditorStore.getState().canUndo).toBe(false);
  });

  it('leaves no way to undo back into the project the file replaced', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('cube'));
    await act(() => project.current.saveProject());
    picked = { name: 'scene.3doo', text: saves[saves.length - 1].contents };
    // The session carries on rather than being reset first, which is what
    // opening a file from the menu actually does.
    act(() => useEditorStore.getState().addPrimitive('torus'));
    expect(useEditorStore.getState().canUndo).toBe(true);

    await act(() => project.current.openProject());

    // One Ctrl+Z would otherwise put back a scene this file never held.
    expect(useEditorStore.getState().canUndo).toBe(false);
  });

  it('brings the stored copy level with the file that was just opened', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('cube'));
    await act(() => project.current.saveProject());
    stored.length = 0;
    picked = { name: 'scene.3doo', text: saves[saves.length - 1].contents };

    await act(() => project.current.openProject());

    // Left alone, the record would still be the project the file replaced, and
    // a reload before the first edit would come back on it.
    expect(stored).toEqual(['write']);
  });

  it('clears that copy instead when autosave is off', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('cube'));
    await act(() => project.current.saveProject());
    stored.length = 0;
    picked = { name: 'scene.3doo', text: saves[saves.length - 1].contents };
    act(() => useEditorStore.setState({ autosaveEnabled: false }));

    await act(() => project.current.openProject());

    // Nothing is being kept from here on, so what is still in storage is the
    // project this file replaced.
    expect(stored).toEqual(['clear']);
  });

  it('counts a freshly opened project as one a file already holds', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('cube'));
    await act(() => project.current.saveProject());
    picked = { name: 'scene.3doo', text: saves[saves.length - 1].contents };
    act(() => useEditorStore.getState().resetScene());

    await act(() => project.current.openProject());

    // The scene came out of a file that is still there, so FILE > NEW has as
    // little to warn about as it does straight after a save.
    expect(useEditorStore.getState().savedToFile).toBe(true);
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
