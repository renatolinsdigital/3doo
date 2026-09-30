import { describe, expect, it, vi } from 'vitest';

import {
  BMesh,
  type ProjectDocument,
  createTransform,
  deserializeProject,
  serializeProject,
  vec3,
} from '@kernel/index';

import {
  autosaveFolderIn,
  autosaveLocationLabel,
  autosaveStem,
  forgetBrowserCopy,
  nextAutosaveName,
  sceneFingerprint,
  writeNumberedCopy,
} from './autosave';

describe('what earlier builds left in the browser', () => {
  it('deletes the images they kept beside the project', async () => {
    const removeEntry = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'storage', {
      value: { getDirectory: () => Promise.resolve({ removeEntry }) },
      configurable: true,
    });

    try {
      await forgetBrowserCopy();
    } finally {
      Reflect.deleteProperty(navigator, 'storage');
    }

    expect(removeEntry).toHaveBeenCalledWith('assets', { recursive: true });
  });

  it('settles quietly in a browser that never had any', async () => {
    await expect(forgetBrowserCopy()).resolves.toBeUndefined();
  });
});

describe('telling a changed scene from a touched one', () => {
  /**
   * A quad whose edges were made before its face, in an order and a direction
   * the face would not make them in, the way an edit leaves them. All four are
   * selected and sharp, so the order shows in the document.
   */
  function quadEditedOutOfOrder(): BMesh {
    const mesh = new BMesh();
    const [a, b, c, d] = [vec3(0, 0, 0), vec3(1, 0, 0), vec3(1, 1, 0), vec3(0, 1, 0)].map((co) =>
      mesh.addVert(co),
    );
    mesh.addEdge(d, c);
    mesh.addEdge(b, a);
    mesh.addFace([a, b, c, d]);
    for (const edge of mesh.edges.values()) {
      edge.selected = true;
      edge.sharp = true;
    }
    return mesh;
  }

  function sceneAround(mesh: BMesh): ProjectDocument {
    const quad = {
      id: 'quad',
      name: 'QUAD',
      transform: createTransform(),
      visible: true,
      locked: false,
      parentId: null,
      groupId: null,
      materials: [],
      modifiers: [],
      activeMaterial: 0,
      mesh,
    };
    return serializeProject('lamp', [quad], vec3(), quad.id);
  }

  it('reads two snapshots of one scene as the same, whenever they were written', () => {
    const document = sceneAround(quadEditedOutOfOrder());
    const later = { ...document, savedAt: '2030-01-01T00:00:00.000Z' };

    expect(sceneFingerprint(later)).toBe(sceneFingerprint(document));
  });

  it('leaves out which object was active and which panels were folded', () => {
    const document = sceneAround(quadEditedOutOfOrder());
    const lookedAround = { ...document, activeObjectId: null, panels: { OUTLINER: true } };

    expect(sceneFingerprint(lookedAround)).toBe(sceneFingerprint(document));
  });

  it('reads a mesh put back from its own document as the same scene', () => {
    // What undo does: the document is read back into a mesh, which makes its
    // edges face by face, and that mesh is what the next tick snapshots.
    const document = sceneAround(quadEditedOutOfOrder());
    const restored = deserializeProject(document);
    const replayed = serializeProject(
      restored.name,
      restored.objects,
      restored.cursor,
      restored.activeObjectId,
      restored.groups,
      restored.assets,
    );

    expect(replayed.objects[0].mesh.selection.edges).not.toEqual(
      document.objects[0].mesh.selection.edges,
    );
    expect(sceneFingerprint(replayed)).toBe(sceneFingerprint(document));
  });

  it('tells apart anything a file would hold differently', () => {
    const document = sceneAround(quadEditedOutOfOrder());
    const [quad] = document.objects;

    const moved = structuredClone(document);
    moved.objects[0].mesh.positions[0] = 0.5;
    const deselected = structuredClone(document);
    deselected.objects[0].mesh.selection.edges.pop();
    const changes = [
      moved,
      deselected,
      { ...document, objects: [{ ...quad, name: 'LAMP POST' }] },
      { ...document, cursor: vec3(0, 1, 0) },
      { ...document, groups: [{ id: 'group-1', name: 'GROUP' }] },
    ];

    for (const changed of changes) {
      expect(sceneFingerprint(changed)).not.toBe(sceneFingerprint(document));
    }
  });
});

describe('what a numbered copy is called', () => {
  it('takes the name of the .3doo, without its suffix', () => {
    expect(autosaveStem({ name: 'lamp.3doo' }, 'untitled')).toBe('lamp');
    // The older spelling opening still accepts.
    expect(autosaveStem({ name: 'lamp.3doo.json' }, 'untitled')).toBe('lamp');
    expect(autosaveStem({ name: 'Lamp.3DOO' }, 'untitled')).toBe('Lamp');
  });

  it('takes the project name until there is a file, and untitled before that', () => {
    expect(autosaveStem(null, 'LAMP POST')).toBe('LAMP POST');
    expect(autosaveStem(null, 'untitled')).toBe('untitled');
    expect(autosaveStem(null, '   ')).toBe('untitled');
  });

  it('keeps out what no file name may hold', () => {
    expect(autosaveStem(null, 'a/b: c?')).toBe('a_b_ c_');
    // Windows drops a trailing dot, which would name the copy something else.
    expect(autosaveStem(null, 'draft.')).toBe('draft');
  });

  it('numbers the first copy 01', () => {
    expect(nextAutosaveName('lamp', [])).toBe('lamp_01.3doo');
  });

  it('goes one past the highest already there, gaps and all', () => {
    expect(nextAutosaveName('lamp', ['lamp_01.3doo', 'lamp_04.3doo', 'lamp_02.3doo'])).toBe(
      'lamp_05.3doo',
    );
  });

  it('counts only its own copies', () => {
    const names = ['lamp.3doo', 'lamp_post_09.3doo', 'lampshade_07.3doo', 'lamp_03.txt'];

    expect(nextAutosaveName('lamp', names)).toBe('lamp_01.3doo');
  });

  it('reads a name as text, not as a pattern', () => {
    // A dot in a name is a dot, not "any character", so v1x2 is not v1.2.
    expect(nextAutosaveName('v1.2', ['v1x2_05.3doo', 'v1.2_02.3doo'])).toBe('v1.2_03.3doo');
  });

  it('keeps counting past 99', () => {
    expect(nextAutosaveName('lamp', ['lamp_99.3doo'])).toBe('lamp_100.3doo');
  });
});

describe('writing a numbered copy', () => {
  /** A 3doo-auto-saves holding `names`, answering the permission query with `permission`. */
  function folderWith(names: string[], permission: PermissionState = 'granted') {
    const files = new Map<string, string>(names.map((name) => [name, 'old']));
    const folder = {
      name: '3doo-auto-saves',
      queryPermission: () => Promise.resolve(permission),
      keys: async function* () {
        yield* [...files.keys()];
      },
      getFileHandle: (name: string) =>
        Promise.resolve({
          createWritable: () =>
            Promise.resolve({
              write: (contents: string) => {
                files.set(name, contents);
                return Promise.resolve();
              },
              close: () => Promise.resolve(),
            }),
        }),
    };
    return { folder: folder as unknown as FileSystemDirectoryHandle, files };
  }

  it('writes the next copy and leaves the ones before it as they were', async () => {
    const { folder, files } = folderWith(['lamp_01.3doo']);

    const result = await writeNumberedCopy(folder, 'lamp', '{"new":true}');

    expect(result).toEqual({ status: 'written', filename: 'lamp_02.3doo' });
    expect(files.get('lamp_01.3doo')).toBe('old');
    expect(files.get('lamp_02.3doo')).toBe('{"new":true}');
  });

  it('writes nothing when the browser has not allowed it, and says which', async () => {
    const { folder, files } = folderWith([], 'prompt');

    expect(await writeNumberedCopy(folder, 'lamp', '{}')).toEqual({ status: 'not-allowed' });
    expect(files.size).toBe(0);
  });

  it('reports a folder that has gone, in the words the browser gives', async () => {
    const folder = {
      name: '3doo-auto-saves',
      queryPermission: () => Promise.resolve('granted'),
      keys: () => {
        throw new DOMException('The folder is gone', 'NotFoundError');
      },
    } as unknown as FileSystemDirectoryHandle;

    expect(await writeNumberedCopy(folder, 'lamp', '{}')).toEqual({
      status: 'failed',
      reason: 'The folder is gone',
    });
  });

  it('writes into a 3doo-auto-saves inside any other location', async () => {
    const { folder: inside, files } = folderWith([]);
    const getDirectoryHandle = vi.fn(() => Promise.resolve(inside));
    const location = {
      name: 'Projects',
      queryPermission: () => Promise.resolve('granted'),
      getDirectoryHandle,
    } as unknown as FileSystemDirectoryHandle;

    expect(await writeNumberedCopy(location, 'lamp', '{}')).toMatchObject({ status: 'written' });
    expect(getDirectoryHandle).toHaveBeenCalledWith('3doo-auto-saves', { create: true });
    expect([...files.keys()]).toEqual(['lamp_01.3doo']);
  });
});

describe('the autosave location', () => {
  const named = (name: string) => ({ name }) as FileSystemDirectoryHandle;

  it('is labelled with the folder the copies go in', () => {
    expect(autosaveLocationLabel(named('Projects'))).toBe('Projects/3doo-auto-saves');
  });

  it('is the copies folder itself when the user picked that, in any case', () => {
    // Named by hand, so its case is whatever was typed.
    expect(autosaveLocationLabel(named('3DOO-Auto-Saves'))).toBe('3DOO-Auto-Saves');
  });

  it('is a plain root at the top of a drive, which the browser names by its separator', () => {
    expect(autosaveLocationLabel(named('\\'))).toBe('/3doo-auto-saves');
    expect(autosaveLocationLabel(named('/'))).toBe('/3doo-auto-saves');
  });

  it('keeps its copies folder when it already is one, rather than nesting another', async () => {
    const getDirectoryHandle = vi.fn();
    const location = { name: '3doo-auto-saves', getDirectoryHandle };

    expect(await autosaveFolderIn(location as unknown as FileSystemDirectoryHandle)).toBe(location);
    expect(getDirectoryHandle).not.toHaveBeenCalled();
  });
});
