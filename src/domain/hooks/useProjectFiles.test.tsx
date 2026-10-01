import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ExportObject, createBox, createTransform, exportFBX } from '@kernel/index';
import { useEditorStore } from '@store/index';

import { useProjectFiles } from './useProjectFiles';

import type { FileKind, SaveResult } from '../services/download';

/** Stands in for a file on disk: all the hook ever reads off one is its name. */
function fakeHandle(name: string): FileSystemFileHandle {
  return { name } as FileSystemFileHandle;
}

const downloads: { filename: string; contents: BlobPart }[] = [];
const saves: { suggestedName: string; contents: string; kind: FileKind }[] = [];
const overwrites: { handle: FileSystemFileHandle; contents: string }[] = [];
/** What the picker hands back. Leaving `handle` out is the file input route. */
let picked: { name: string; text: string; handle?: FileSystemFileHandle } | null = null;
let pickedFile: File | null = null;
let pixels = { width: 800, height: 400 };
let saveResult: SaveResult = {
  status: 'saved',
  filename: 'placeholder',
  handle: fakeHandle('placeholder'),
};
/** Null writes through whichever handle it is given, which is the usual ending. */
let overwriteResult: SaveResult | null = null;

// `saveResultToast` is deliberately left real: the mapping from outcome to
// message is what these tests are checking.
vi.mock('../services/download', async () => {
  const actual =
    await vi.importActual<typeof import('../services/download')>('../services/download');
  return {
    ...actual,
    downloadFile: (filename: string, contents: BlobPart) => downloads.push({ filename, contents }),
    pickTextFile: () => Promise.resolve(picked && { handle: null, ...picked }),
    pickFile: () => Promise.resolve(pickedFile),
    saveTextFile: (suggestedName: string, contents: string, kind: FileKind) => {
      saves.push({ suggestedName, contents, kind });
      return Promise.resolve(saveResult);
    },
    overwriteTextFile: (handle: FileSystemFileHandle, contents: string) => {
      overwrites.push({ handle, contents });
      return Promise.resolve(overwriteResult ?? { status: 'saved', filename: handle.name, handle });
    },
  };
});

// The image decoder is stubbed: jsdom has none. Everything else in the
// service, including the base64 a file save runs on, is the real thing.
vi.mock('../services/assets', async () => {
  const actual = await vi.importActual<typeof import('../services/assets')>('../services/assets');
  return {
    ...actual,
    imageDimensions: () => Promise.resolve(pixels),
  };
});

const TRIANGLE_OBJ = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n';

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
    overwrites.length = 0;
    picked = null;
    pickedFile = null;
    pixels = { width: 800, height: 400 };
    saveResult = { status: 'saved', filename: 'placeholder', handle: fakeHandle('placeholder') };
    overwriteResult = null;
    useEditorStore.setState({ autosaveEnabled: true });
    useEditorStore.getState().resetScene();
    useEditorStore.setState({ toasts: [] });
  });

  it('offers the project name to the save dialog, and reports where it landed', async () => {
    const project = files();
    act(() => useEditorStore.getState().setProjectName('LAMP POST'));
    saveResult = { status: 'saved', filename: 'lamp.3doo', handle: fakeHandle('lamp.3doo') };

    await act(() => project.current.saveProjectAs());

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

    await act(() => project.current.saveProjectAs());

    expect(lastToast().message).toBe('Saved CRATE.3doo to your downloads');
  });

  it('refuses to overwrite a file that is already there', async () => {
    const project = files();
    saveResult = { status: 'exists', filename: 'taken.3doo' };

    await act(() => project.current.saveProjectAs());

    expect(lastToast()).toMatchObject({
      variant: 'error',
      message: 'taken.3doo already exists, save under a different name',
    });
  });

  it('says nothing when the save dialog is dismissed', async () => {
    const project = files();
    saveResult = { status: 'cancelled', filename: 'untitled.3doo' };

    await act(() => project.current.saveProjectAs());

    expect(toasts()).toHaveLength(0);
  });

  it('counts the project as saved once the file is on disk', async () => {
    const project = files();
    act(() => useEditorStore.getState().addPrimitive('cube'));
    expect(useEditorStore.getState().dirty).toBe(true);
    saveResult = { status: 'saved', filename: 'crate.3doo', handle: fakeHandle('crate.3doo') };

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

    await act(() => project.current.saveProjectAs());

    expect(saves[0].suggestedName).toBe('untitled.3doo');
  });

  it('names both files an OBJ export writes, not just the mesh', async () => {
    const project = files();
    act(() => {
      const state = useEditorStore.getState();
      state.setProjectName('CRATE');
      state.addPrimitive('cube');
    });

    await act(() => project.current.exportModel('obj'));

    expect(downloads.map((entry) => entry.filename)).toEqual(['CRATE.obj', 'CRATE.mtl']);
    // The .mtl arrives beside the .obj; a message naming only the mesh is how
    // the material file gets left behind.
    expect(lastToast().message).toBe('Saved CRATE.obj and CRATE.mtl to your downloads');
  });

  it('says why there was nothing to export', async () => {
    const project = files();

    await act(() => project.current.exportModel('obj'));
    expect(lastToast()).toMatchObject({ variant: 'warning' });
    expect(lastToast().message).toMatch(/empty or every object is hidden/);

    act(() => {
      useEditorStore.getState().addPrimitive('cube');
      useEditorStore.setState({ selectedObjectIds: [] });
    });

    await act(() => project.current.exportModel('obj', true));
    expect(lastToast().message).toBe('Nothing selected to export');
  });

  it('sends an image plane to OBJ with its picture beside it, named in the material file', async () => {
    const project = files();
    act(() => useEditorStore.getState().setProjectName('MOOD BOARD'));
    pickedFile = imageFile('my ref.png');
    await act(() => project.current.importImage());

    await act(() => project.current.exportModel('obj'));

    // No spaces in what the .obj and .mtl name: an OBJ reader stops at the first.
    expect(downloads.map((entry) => entry.filename)).toEqual([
      'MOOD BOARD.obj',
      'MOOD_BOARD.mtl',
      'my_ref.png',
    ]);
    expect(String(downloads[0].contents)).toContain('mtllib MOOD_BOARD.mtl');
    expect(String(downloads[1].contents)).toContain('map_Kd my_ref.png');
    expect(lastToast().message).toBe(
      'Saved MOOD BOARD.obj, MOOD_BOARD.mtl and my_ref.png to your downloads',
    );
  });

  it('gives two pictures that share a name a file each', async () => {
    const project = files();
    act(() => useEditorStore.getState().setProjectName('BOARD'));
    pickedFile = imageFile();
    await act(() => project.current.importImage());
    pickedFile = imageFile();
    await act(() => project.current.importImage());

    await act(() => project.current.exportModel('obj'));

    expect(downloads.map((entry) => entry.filename)).toEqual([
      'BOARD.obj',
      'BOARD.mtl',
      'ref.png',
      'ref_2.png',
    ]);
  });

  it('embeds the picture in the FBX, so the one file carries it', async () => {
    const project = files();
    pickedFile = imageFile();
    await act(() => project.current.importImage());

    await act(() => project.current.exportModel('fbx'));

    expect(downloads).toHaveLength(1);
    const bytes = downloads[0].contents as Uint8Array;
    // A raw property: type R, a four-byte length, then the image's own bytes.
    const content = [0x52, 4, 0, 0, 0, 1, 2, 3, 4];
    const found = bytes.findIndex((_, start) =>
      content.every((value, offset) => bytes[start + offset] === value),
    );
    expect(found).toBeGreaterThan(0);
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

    // A .3doo is the scene, not the route taken to it.
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
    // stayed in the tab that took them.
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

  it('refuses a mesh import that is neither OBJ nor FBX', async () => {
    const project = files();

    pickedFile = new File(['solid chair\n'], 'chair.stl');
    await act(() => project.current.importMesh());

    expect(lastToast()).toMatchObject({
      variant: 'error',
      message: 'chair.stl is not an OBJ or FBX mesh, expected .obj or .fbx',
    });
    expect(useEditorStore.getState().objects).toHaveLength(0);
  });

  it('accepts the extension whatever its case', async () => {
    const project = files();

    pickedFile = new File([TRIANGLE_OBJ], 'CHAIR.OBJ');
    await act(() => project.current.importMesh());

    expect(lastToast()).toMatchObject({ variant: 'success' });
  });

  it('stays quiet when the picker is dismissed', async () => {
    const project = files();

    picked = null;
    pickedFile = null;
    await act(() => project.current.openProject());
    await act(() => project.current.importMesh());

    expect(toasts()).toHaveLength(0);
  });

  it('names the file geometry was imported from', async () => {
    const project = files();

    pickedFile = new File([TRIANGLE_OBJ], 'chair.obj');
    await act(() => project.current.importMesh());

    expect(lastToast()).toMatchObject({ variant: 'success' });
    expect(lastToast().message).toBe('Imported 1 object(s) from chair.obj');
  });

  it('reads a binary FBX, whose bytes would not survive being read as text', async () => {
    const project = files();
    const box: ExportObject = {
      name: 'Crate',
      mesh: createBox(2),
      transform: createTransform(),
      materials: [],
    };

    pickedFile = new File([exportFBX([box])], 'crate.fbx');
    await act(() => project.current.importMesh());

    const state = useEditorStore.getState();
    expect(state.objects.map((object) => object.name)).toEqual(['CRATE']);
    expect(state.objects[0].mesh.faces.size).toBe(6);
    expect(lastToast()).toMatchObject({
      variant: 'success',
      message: 'Imported 1 object(s) from crate.fbx',
    });
  });

  it('names the file an import failed on, and why', async () => {
    const project = files();

    pickedFile = new File(['v 0 0 0\n'], 'chair.fbx');
    await act(() => project.current.importMesh());

    expect(lastToast()).toMatchObject({
      variant: 'error',
      message: 'Could not import chair.fbx: Not an FBX file',
    });
    expect(useEditorStore.getState().objects).toHaveLength(0);
  });

  it('warns by name when a file holds no geometry', async () => {
    const project = files();

    pickedFile = new File(['# nothing here\n'], 'empty.obj');
    await act(() => project.current.importMesh());

    expect(lastToast()).toMatchObject({
      variant: 'warning',
      message: 'No geometry found in empty.obj',
    });
  });

  describe('SAVE and SAVE AS', () => {
    /** A valid .3doo holding one cube, to open. */
    async function projectText(project: ReturnType<typeof files>) {
      act(() => useEditorStore.getState().addPrimitive('cube'));
      await act(() => project.current.saveProjectAs());
      return saves[saves.length - 1].contents;
    }

    it('saves straight back over the file SAVE AS wrote, without asking again', async () => {
      const project = files();
      const lamp = fakeHandle('lamp.3doo');
      saveResult = { status: 'saved', filename: 'lamp.3doo', handle: lamp };
      await act(() => project.current.saveProjectAs());

      act(() => useEditorStore.getState().addPrimitive('torus'));
      await act(() => project.current.saveProject());

      expect(saves).toHaveLength(1);
      expect(overwrites.map((write) => write.handle)).toEqual([lamp]);
      expect(JSON.parse(overwrites[0].contents).objects[0].name).toBe('TORUS');
      expect(lastToast()).toMatchObject({ variant: 'success', message: 'Saved lamp.3doo' });
    });

    it('saves back over the file the project was opened from', async () => {
      const project = files();
      const scene = fakeHandle('scene.3doo');
      picked = { name: 'scene.3doo', text: await projectText(project), handle: scene };
      await act(() => project.current.openProject());

      await act(() => project.current.saveProject());

      expect(overwrites.map((write) => write.handle)).toEqual([scene]);
    });

    it('names the project after the file SAVE AS wrote, whatever the dialog was offered', async () => {
      const project = files();
      act(() => useEditorStore.getState().setProjectName('LAMP POST'));
      saveResult = { status: 'saved', filename: 'lamp.3doo', handle: fakeHandle('lamp.3doo') };

      await act(() => project.current.saveProjectAs());

      // The top bar names the file SAVE writes over, so it takes the name the
      // dialog settled on. Renaming is part of the save, not an edit after it.
      expect(useEditorStore.getState().projectName).toBe('lamp');
      expect(useEditorStore.getState().dirty).toBe(false);
      expect(useEditorStore.getState().savedToFile).toBe(true);
    });

    it('names the project after the file it opened, not the name saved inside it', async () => {
      const project = files();
      act(() => useEditorStore.getState().setProjectName('LAMP POST'));
      const text = await projectText(project);
      act(() => useEditorStore.getState().resetScene());
      picked = { name: 'lamp-v2.3doo', text, handle: fakeHandle('lamp-v2.3doo') };

      await act(() => project.current.openProject());

      expect(useEditorStore.getState().projectName).toBe('lamp-v2');
      expect(useEditorStore.getState().dirty).toBe(false);
      expect(useEditorStore.getState().savedToFile).toBe(true);
    });

    it('asks where once the project is renamed away from its file', async () => {
      const project = files();
      saveResult = { status: 'saved', filename: 'lamp.3doo', handle: fakeHandle('lamp.3doo') };
      await act(() => project.current.saveProjectAs());

      act(() => useEditorStore.getState().setProjectName('NAAAADA'));
      await act(() => project.current.saveProject());

      // A different name is a different file, so SAVE asks where it goes
      // rather than writing it over lamp.3doo.
      expect(saves).toHaveLength(2);
      expect(saves[1].suggestedName).toBe('NAAAADA.3doo');
      expect(overwrites).toHaveLength(0);
    });

    it('saves over the file again once its name is put back', async () => {
      const project = files();
      const lamp = fakeHandle('lamp.3doo');
      saveResult = { status: 'saved', filename: 'lamp.3doo', handle: lamp };
      await act(() => project.current.saveProjectAs());

      act(() => useEditorStore.getState().setProjectName('NAAAADA'));
      act(() => useEditorStore.getState().setProjectName('lamp'));
      await act(() => project.current.saveProject());

      expect(saves).toHaveLength(1);
      expect(overwrites.map((write) => write.handle)).toEqual([lamp]);
    });

    it('asks where while there is nothing to save over, since the key still has to save', async () => {
      const project = files();

      await act(() => project.current.saveProject());

      expect(saves).toHaveLength(1);
      expect(overwrites).toHaveLength(0);
    });

    it('still asks where on SAVE AS when there is a file to save over', async () => {
      const project = files();
      await act(() => project.current.saveProjectAs());

      await act(() => project.current.saveProjectAs());

      expect(saves).toHaveLength(2);
      expect(overwrites).toHaveLength(0);
    });

    it('keeps the file through an edit, which only takes savedToFile away', async () => {
      const project = files();
      await act(() => project.current.saveProjectAs());

      act(() => useEditorStore.getState().addPrimitive('cube'));

      // The project still belongs to that file. It has moved on from what the
      // file holds, which is what SAVE is there for.
      expect(useEditorStore.getState().projectFile?.name).toBe('placeholder');
      expect(useEditorStore.getState().savedToFile).toBe(false);
    });

    it('forgets the file once a new project starts', async () => {
      const project = files();
      await act(() => project.current.saveProjectAs());

      await act(() => project.current.newProject());

      expect(useEditorStore.getState().projectFile).toBeNull();
    });

    it('has nothing to save over after an open that only lent the page a copy', async () => {
      const project = files();
      // No handle: the file input route, which is every browser without the
      // open picker.
      picked = { name: 'scene.3doo', text: await projectText(project) };

      await act(() => project.current.openProject());

      expect(useEditorStore.getState().projectFile).toBeNull();
    });

    it('has nothing to save over after a save the browser downloaded', async () => {
      const project = files();
      await act(() => project.current.saveProjectAs());
      saveResult = { status: 'downloaded', filename: 'untitled.3doo' };

      await act(() => project.current.saveProjectAs());

      // The last save is in the downloads folder, out of reach. Writing over
      // the file before it would be writing over something else.
      expect(useEditorStore.getState().projectFile).toBeNull();
    });

    it('leaves the file it had when the save is dismissed', async () => {
      const project = files();
      await act(() => project.current.saveProjectAs());
      saveResult = { status: 'cancelled', filename: 'untitled.3doo' };

      await act(() => project.current.saveProjectAs());

      expect(useEditorStore.getState().projectFile?.name).toBe('placeholder');
    });

    it('says why the file did not change, and leaves the work pending', async () => {
      const project = files();
      await act(() => project.current.saveProjectAs());
      act(() => useEditorStore.getState().addPrimitive('cube'));
      overwriteResult = { status: 'failed', filename: 'placeholder', reason: 'it is locked' };

      await act(() => project.current.saveProject());

      expect(lastToast()).toMatchObject({
        variant: 'error',
        message: 'Could not save placeholder: it is locked',
      });
      expect(useEditorStore.getState().dirty).toBe(true);
      expect(useEditorStore.getState().savedToFile).toBe(false);
    });
  });
});
