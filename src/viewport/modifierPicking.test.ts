import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { ObjectView } from '@bridge/index';
import { type Vec3, vec3 } from '@kernel/index';
import { DEFAULT_PREFERENCES, evaluatedMesh, useEditorStore } from '@store/index';
import type { SceneObject, ViewportSettings } from '@store/types';

import { facingElements, pickElement } from './picking';

const SIZE = { width: 200, height: 200 };

/** Off every axis, so no two corners of the box land on the same pixel. */
function camera(): THREE.PerspectiveCamera {
  const view = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  view.position.set(3, 2.4, 4);
  view.lookAt(0, 0, 0);
  view.updateMatrixWorld(true);
  return view;
}

/** Where a point on the object lands, in canvas pixels. The object sits at the origin. */
function pixel(point: Vec3, view: THREE.Camera): THREE.Vector2 {
  const ndc = new THREE.Vector3(point.x, point.y, point.z).project(view);
  return new THREE.Vector2(((ndc.x + 1) / 2) * SIZE.width, ((1 - ndc.y) / 2) * SIZE.height);
}

/**
 * A unit box previewing under a subdivision modifier, drawn in edit mode.
 *
 * The modifier rebuilds the mesh from scratch, so the shape on screen carries
 * hundreds of elements of its own and none of the box's ids: exactly the case
 * where a pick has to answer with the box rather than with the preview.
 *
 * Smoothed, so the preview pulls away from the cage. Left at the flat default
 * every corner of the preview sits on a corner of the box, and a pick landing
 * on the wrong mesh would still come back with the right answer.
 */
function subdividedBox(): { object: SceneObject; view: ObjectView } {
  const store = useEditorStore.getState();
  store.resetScene();
  store.addPrimitive('box');
  store.addModifier('subdivide');
  const added = useEditorStore.getState().objects[0].modifiers[0];
  store.updateModifier(added.id, { levels: 2, smooth: 1 });

  const state = useEditorStore.getState();
  const object = state.objects[0];
  const settings: ViewportSettings = {
    shading: state.shading,
    backfaceCulling: state.backfaceCulling,
    orthographic: state.orthographic,
    focalLength: state.focalLength,
    clipStart: state.clipStart,
    clipEnd: state.clipEnd,
    navigation: state.navigation,
    overlays: state.overlays,
  };

  const view = new ObjectView(object.id);
  view.update(object, evaluatedMesh(object), {
    mode: 'edit',
    selectMode: 'vertex',
    isActive: true,
    isSelected: true,
    eye: vec3(3, 2.4, 4),
    selectionLine: {
      color: DEFAULT_PREFERENCES.selectionLineColor,
      width: DEFAULT_PREFERENCES.selectionLineWidth,
    },
    meshVersion: 1,
    settings,
  });
  view.group.updateMatrixWorld(true);

  return { object, view };
}

function pick(object: SceneObject, view: ObjectView, mode: 'vertex' | 'edge' | 'face', at: Vec3) {
  const eye = camera();
  const pointer = pixel(at, eye);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(
    new THREE.Vector2((pointer.x / SIZE.width) * 2 - 1, -(pointer.y / SIZE.height) * 2 + 1),
    eye,
  );

  return pickElement(
    view,
    object.mesh,
    mode,
    pointer,
    eye,
    SIZE,
    raycaster,
    facingElements(object.mesh, view.group.matrix, eye),
  );
}

describe('picking a mesh under a modifier preview', () => {
  it('offers the mesh being edited, not the preview built from it', () => {
    const { object, view } = subdividedBox();

    expect(evaluatedMesh(object).verts.size).toBeGreaterThan(object.mesh.verts.size);
    expect(view.vertIds).toHaveLength(object.mesh.verts.size);
    expect(view.edgeIds).toHaveLength(object.mesh.edges.size);
  });

  it('picks the corner the pointer is on', () => {
    const { object, view } = subdividedBox();
    const corner = vec3(0.5, 0.5, 0.5);

    const result = pick(object, view, 'vertex', corner);

    expect(result).not.toBeNull();
    const vert = object.mesh.verts.get(result?.elementId ?? -1);
    // By position rather than by id: both meshes number from one, and a
    // subdivision carries the ids of the cage it grew from, so an id the box
    // happens to hold is no proof the pick came off the box.
    expect(vert?.co).toEqual(corner);

    // And the dot it was picked against stands on the corner, rather than
    // where the preview pulled that corner to.
    const index = [...view.vertIds].indexOf(result?.elementId ?? -1);
    expect([...view.vertPositions.slice(index * 3, index * 3 + 3)]).toEqual([0.5, 0.5, 0.5]);
  });

  it('picks the edge the pointer is on', () => {
    const { object, view } = subdividedBox();

    // The midpoint of the box's top front edge, which the preview has cut in
    // two and pulled inwards.
    const result = pick(object, view, 'edge', vec3(0, 0.5, 0.5));

    expect(result).not.toBeNull();
    const edge = object.mesh.edges.get(result?.elementId ?? -1);
    expect(edge).toBeDefined();
    expect(edge && object.mesh.edgeCenter(edge)).toEqual(vec3(0, 0.5, 0.5));
  });

  it('picks the face the ray lands on', () => {
    const { object, view } = subdividedBox();

    const result = pick(object, view, 'face', vec3(0, 0, 0.5));

    expect(result).not.toBeNull();
    const face = object.mesh.faces.get(result?.elementId ?? -1);
    expect(face).toBeDefined();
    expect(face && object.mesh.faceCenter(face)).toEqual(vec3(0, 0, 0.5));
  });

  it('leaves picking to the surface itself with nothing on the stack', () => {
    const { object, view } = subdividedBox();
    const store = useEditorStore.getState();
    store.removeModifier(object.modifiers[0].id);

    const plain = useEditorStore.getState().objects[0];
    view.update(plain, evaluatedMesh(plain), {
      mode: 'edit',
      selectMode: 'vertex',
      isActive: true,
      isSelected: true,
      eye: vec3(3, 2.4, 4),
      meshVersion: 2,
      selectionLine: {
        color: DEFAULT_PREFERENCES.selectionLineColor,
        width: DEFAULT_PREFERENCES.selectionLineWidth,
      },
      settings: {
        shading: store.shading,
        backfaceCulling: store.backfaceCulling,
        orthographic: store.orthographic,
        focalLength: store.focalLength,
        clipStart: store.clipStart,
        clipEnd: store.clipEnd,
        navigation: store.navigation,
        overlays: store.overlays,
      },
    });

    expect(view.pickTarget.name).toBe(`${plain.id}:solid`);
  });

  it('sends the ray at the cage while a modifier is previewing', () => {
    const { object, view } = subdividedBox();

    expect(view.pickTarget.name).toBe(`${object.id}:cage`);
  });
});
