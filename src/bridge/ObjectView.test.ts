import * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { describe, expect, it, vi } from 'vitest';

import { add, vec3 } from '@kernel/index';
import { DEFAULT_PREFERENCES, evaluatedMesh, useEditorStore } from '@store/index';
import type { SceneObject, ViewportSettings } from '@store/types';

import { ObjectView } from './ObjectView';
import * as meshBuffers from './meshBuffers';
import { buildEdgeCull, frontEdgePositions } from './meshBuffers';

const SELECTION_LINE = {
  color: DEFAULT_PREFERENCES.selectionLineColor,
  width: DEFAULT_PREFERENCES.selectionLineWidth,
};

function scene(): { object: SceneObject; settings: ViewportSettings } {
  const store = useEditorStore.getState();
  store.resetScene();
  store.addPrimitive('cube');
  const state = useEditorStore.getState();
  const object = state.objects[0];
  return {
    object,
    settings: {
      shading: state.shading,
      backfaceCulling: state.backfaceCulling,
      orthographic: state.orthographic,
      focalLength: state.focalLength,
      clipStart: state.clipStart,
      clipEnd: state.clipEnd,
      navigation: state.navigation,
      overlays: state.overlays,
    },
  };
}

function surfaceMaterial(view: ObjectView, id: string): THREE.Material | THREE.Material[] {
  const solid = view.group.getObjectByName(`${id}:solid`) as THREE.Mesh;
  return solid.material;
}

describe('ObjectView', () => {
  it('keeps its surface materials across an unchanged redraw', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    const state = {
      mode: 'object' as const,
      selectMode: 'vertex' as const,
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    };

    view.update(object, evaluatedMesh(object), state);
    const first = surfaceMaterial(view, object.id);

    // A gizmo drag redraws on every pointer move. Rebuilding the materials
    // there disposes the shader program with them and the next frame has to
    // compile it again, which is what made a drag stutter.
    view.update(object, evaluatedMesh(object), state);
    expect(surfaceMaterial(view, object.id)).toBe(first);
  });

  it('rebuilds them when the shading mode changes', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    const state = {
      mode: 'object' as const,
      selectMode: 'vertex' as const,
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    };

    view.update(object, evaluatedMesh(object), state);
    const first = surfaceMaterial(view, object.id);

    view.update(object, evaluatedMesh(object), {
      ...state,
      settings: { ...settings, shading: 'solid' },
    });

    expect(surfaceMaterial(view, object.id)).not.toBe(first);
  });
});

describe('ObjectView image plane', () => {
  function imagePlane(): { object: SceneObject; settings: ViewportSettings } {
    const { object, settings } = scene();
    return { object: { ...object, image: { assetId: 'asset-1' } }, settings };
  }

  function wireOf(view: ObjectView): LineSegments2 | undefined {
    return view.group.children.find(
      (child): child is LineSegments2 => child instanceof LineSegments2 && child.renderOrder === 0,
    );
  }

  it.each(['solidWire', 'wireframe', 'xray', 'matcap'] as const)(
    'draws the picture solid under %s shading, as it does under solid',
    (shading) => {
      const { object, settings } = imagePlane();
      const view = new ObjectView(object.id);
      const texture = new THREE.Texture();

      view.update(object, evaluatedMesh(object), {
        mode: 'object',
        selectMode: 'vertex',
        isActive: false,
        isSelected: false,
        eye: vec3(0, 0, 10),
        selectionLine: SELECTION_LINE,
        meshVersion: 1,
        texture,
        settings: { ...settings, shading },
      });

      const solid = view.group.getObjectByName(`${object.id}:solid`) as THREE.Mesh;
      const material = (
        Array.isArray(solid.material) ? solid.material[0] : solid.material
      ) as THREE.MeshBasicMaterial;

      expect(solid.visible).toBe(true);
      expect(material.map).toBe(texture);
      // Solid + wire would rule the reference into squares, and the object is
      // an image before it is four vertices.
      expect(wireOf(view)?.visible ?? false).toBe(false);
    },
  );

  it('leaves the shading mode to every object that is not an image', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), {
      mode: 'object',
      selectMode: 'vertex',
      isActive: false,
      isSelected: false,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings: { ...settings, shading: 'wireframe' },
    });

    expect((view.group.getObjectByName(`${object.id}:solid`) as THREE.Mesh).visible).toBe(false);
    expect(wireOf(view)?.visible).toBe(true);
  });

  it('still shows the cage in edit mode, which is what a click picks', () => {
    const { object, settings } = imagePlane();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), {
      mode: 'edit',
      selectMode: 'vertex',
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      texture: new THREE.Texture(),
      settings: { ...settings, shading: 'wireframe' },
    });

    expect(wireOf(view)?.visible).toBe(true);
  });
});

describe('ObjectView selection outline', () => {
  function outlineOf(view: ObjectView, id: string): LineSegments2 {
    return view.group.getObjectByName(`${id}:outline`) as LineSegments2;
  }

  function outlineMaterial(view: ObjectView, id: string): LineMaterial {
    return outlineOf(view, id).material as LineMaterial;
  }

  // The outline is instanced quads, one per segment, so the segment count is on
  // `instanceStart`: `position` holds the quad the shader expands, not the line.
  function segmentCount(line: LineSegments2): number {
    return line.geometry.getAttribute('instanceStart')?.count ?? 0;
  }

  it('traces the silhouette of a selected object, and nothing when deselected', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    const base = {
      mode: 'object' as const,
      selectMode: 'vertex' as const,
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    };

    view.update(object, evaluatedMesh(object), base);
    const outline = outlineOf(view, object.id);

    // A cube face on: the four edges of the square it shows, not all twelve.
    expect(outline.visible).toBe(true);
    expect(segmentCount(outline)).toBe(4);

    view.update(object, evaluatedMesh(object), { ...base, isSelected: false, isActive: false });
    expect(outline.visible).toBe(false);
  });

  it('stays out of edit mode, where the wireframe and elements carry selection', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), {
      mode: 'edit',
      selectMode: 'vertex',
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    });

    expect(outlineOf(view, object.id).visible).toBe(false);
  });

  it('marks the active object more strongly than the rest of the selection', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    const base = {
      mode: 'object' as const,
      selectMode: 'vertex' as const,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    };

    view.update(object, evaluatedMesh(object), { ...base, isActive: true });
    const active = outlineMaterial(view, object.id).color.getHex();

    view.update(object, evaluatedMesh(object), { ...base, isActive: false });
    const selected = outlineMaterial(view, object.id).color.getHex();

    expect(active).not.toBe(selected);
  });

  it('has the fill stamp the mask only while there is an outline to keep off', () => {
    // The line is kept off the object's own pixels by the stencil its fill
    // writes, so the two have to switch together: a fill still stamping after
    // the selection moved on would cut a hole in the next object's outline.
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    const base = {
      selectMode: 'vertex' as const,
      isActive: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    };
    const stamping = () =>
      ([surfaceMaterial(view, object.id)].flat() as THREE.Material[]).every(
        (material) => material.stencilWrite,
      );

    view.update(object, evaluatedMesh(object), { ...base, mode: 'object', isSelected: true });
    expect(stamping()).toBe(true);

    view.update(object, evaluatedMesh(object), { ...base, mode: 'object', isSelected: false });
    expect(stamping()).toBe(false);

    // Edit mode draws no outline either, whatever the selection says.
    view.update(object, evaluatedMesh(object), { ...base, mode: 'edit', isSelected: true });
    expect(stamping()).toBe(false);
  });

  it('takes its colour from the preference, and twice its width', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), {
      mode: 'object',
      selectMode: 'vertex',
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: { color: '#3de0d0', width: 5 },
      meshVersion: 1,
      settings,
    });

    const material = outlineMaterial(view, object.id);
    // Half the ribbon lies over the object and is stencilled away, so the
    // preference is met by drawing twice what it asks for: the width someone
    // sets is the width they see.
    expect(material.linewidth).toBe(10);
    expect(material.color.getHexString()).toBe('3de0d0');
  });

  it('sizes the line against the viewport, which the shader cannot know on its own', () => {
    const { object } = scene();
    const view = new ObjectView(object.id);

    view.setResolution(1280, 720, 1);

    expect(outlineMaterial(view, object.id).resolution.toArray()).toEqual([1280, 720]);
  });

  it('sizes the wire in device pixels, not the CSS pixels a display stretches', () => {
    // A plain line was one device pixel. The wire is quads now, and a width
    // asked for in CSS pixels reads heavier on every display with more than one
    // device pixel to them.
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    view.update(object, evaluatedMesh(object), {
      mode: 'object' as const,
      selectMode: 'vertex' as const,
      isActive: true,
      isSelected: false,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings: { ...settings, shading: 'solidWire' },
    });

    view.setResolution(1280, 720, 2);
    const wire = view.group.children.find(
      (child): child is LineSegments2 => child instanceof LineSegments2 && child.renderOrder === 0,
    );

    expect((wire?.material as LineMaterial).linewidth).toBeCloseTo(0.7);
    // The outline keeps asking in the CSS pixels its preference is written in.
    expect(outlineMaterial(view, object.id).linewidth).toBeGreaterThanOrEqual(1);
  });

  it('re-traces from a new camera position without a rebuild', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), {
      mode: 'object',
      selectMode: 'vertex',
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    });
    expect(segmentCount(outlineOf(view, object.id))).toBe(4);

    // Orbiting to a corner puts six edges on the silhouette; nothing in the
    // scene changed, so only this path can pick that up.
    view.refreshForCamera(vec3(10, 10, 10));

    expect(segmentCount(outlineOf(view, object.id))).toBe(6);
  });
});

describe('ObjectView hover mark', () => {
  function hoverOf(view: ObjectView): THREE.Points {
    const points = view.group.children.filter(
      (child): child is THREE.Points => child instanceof THREE.Points,
    );
    // Between the plain dots and the recent-vertex flash, by render order.
    return points[1];
  }

  function editState(settings: ViewportSettings, selectMode: 'vertex' | 'edge') {
    return {
      mode: 'edit' as const,
      selectMode,
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    };
  }

  it('marks the vertex it is handed, at the point it names', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    view.update(object, evaluatedMesh(object), editState(settings, 'vertex'));

    const hover = hoverOf(view);
    expect(hover.visible).toBe(false);

    view.showHoverVert(vec3(0.5, -0.5, 0.5));

    expect(hover.visible).toBe(true);
    expect([...(hover.geometry.getAttribute('position').array as Float32Array)]).toEqual([
      0.5, -0.5, 0.5,
    ]);
  });

  it('draws it larger than the dot it grows out of', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    view.update(object, evaluatedMesh(object), editState(settings, 'vertex'));

    const points = view.group.children.filter(
      (child): child is THREE.Points => child instanceof THREE.Points,
    );
    const dot = (points[0].material as THREE.PointsMaterial).size;
    const mark = (points[1].material as THREE.PointsMaterial).size;

    expect(mark).toBeCloseTo(dot * 1.8, 6);
  });

  it('goes away with the dots, in a mode that has no vertices to hover', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    view.update(object, evaluatedMesh(object), editState(settings, 'vertex'));
    view.showHoverVert(vec3(0.5, -0.5, 0.5));

    view.update(object, evaluatedMesh(object), editState(settings, 'edge'));
    expect(hoverOf(view).visible).toBe(false);

    // And stays away while that mode is what the viewport is in, whoever asks.
    view.showHoverVert(vec3(0.5, -0.5, 0.5));
    expect(hoverOf(view).visible).toBe(false);
  });
});

describe('ObjectView under a modifier', () => {
  function subdividedBox(): { object: SceneObject; settings: ViewportSettings } {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addPrimitive('cube');
    store.addModifier('subdivide');

    const state = useEditorStore.getState();
    return {
      object: state.objects[0],
      settings: {
        shading: state.shading,
        backfaceCulling: state.backfaceCulling,
        orthographic: state.orthographic,
        focalLength: state.focalLength,
        clipStart: state.clipStart,
        clipEnd: state.clipEnd,
        navigation: state.navigation,
        overlays: state.overlays,
      },
    };
  }

  function viewState(settings: ViewportSettings, mode: 'object' | 'edit') {
    return {
      mode,
      selectMode: 'vertex' as const,
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    };
  }

  // Both are instanced quads, one per segment, so the count is on
  // `instanceStart`: `position` holds the quad the shader expands, not the line.
  const segmentsOf = (line: LineSegments2) =>
    line.geometry.getAttribute('instanceStart')?.count ?? 0;

  // What an opaque surface leaves on screen: the edges that are not on the far
  // side of the mesh from where `viewState` puts the camera.
  const frontEdgesOf = (mesh: Parameters<typeof buildEdgeCull>[0]) =>
    frontEdgePositions(buildEdgeCull(mesh), vec3(0, 0, 10)).length / 6;

  it('draws the shape the stack makes, and the cage that makes it, in edit mode', () => {
    const { object, settings } = subdividedBox();
    const display = evaluatedMesh(object);
    const view = new ObjectView(object.id);

    view.update(object, display, viewState(settings, 'edit'));

    const preview = view.group.getObjectByName(`${object.id}:preview`) as LineSegments2;
    const surface = view.group.getObjectByName(`${object.id}:solid`) as THREE.Mesh;
    const wire = view.group.children.find(
      (child): child is LineSegments2 => child instanceof LineSegments2 && child !== preview,
    );

    // A level of subdivision cuts every edge and adds one per new face, so the
    // two counts part company even though the box has not moved a vertex.
    expect(display.edges.size).toBeGreaterThan(object.mesh.edges.size);
    expect(preview.visible).toBe(true);
    expect(segmentsOf(preview)).toBe(frontEdgesOf(display));
    expect(wire && segmentsOf(wire)).toBe(frontEdgesOf(object.mesh));

    // And the surface is still the result, not the cage.
    const triangles = surface.geometry.getAttribute('position').count / 3;
    expect(triangles).toBe(display.faces.size * 2);
  });

  it('keeps the shape on screen reachable while the cage is what picks', () => {
    const { object, settings } = subdividedBox();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), viewState(settings, 'edit'));

    // Two different meshes, which is how the viewport knows a modifier stands
    // between what a click picks and what the pointer is over.
    expect(view.surfaceTarget.name).toBe(`${object.id}:solid`);
    expect(view.pickTarget).not.toBe(view.surfaceTarget);

    view.update(object, evaluatedMesh(object), viewState(settings, 'object'));
    expect(view.pickTarget).toBe(view.surfaceTarget);
  });

  it('re-culls the wire from a new camera without touching the mesh again', () => {
    // The tables the cull runs over are flattened out of the mesh, which costs
    // more than the whole pass does. A drag redraws on every pointer move and
    // an orbit re-culls on every frame, so neither may pay for that twice.
    const { object, settings } = subdividedBox();
    const view = new ObjectView(object.id);
    const state = viewState(settings, 'edit');
    const flatten = vi.spyOn(meshBuffers, 'buildEdgeCull');
    // The one mesh the stack evaluated, the way the viewport hands the same
    // memoised result to every redraw at a given version.
    const display = evaluatedMesh(object);

    view.update(object, display, state);
    const first = flatten.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    // Same mesh, same version: a redraw and an orbit both read what is held.
    view.update(object, display, state);
    view.refreshForCamera(vec3(10, 10, 10));
    expect(flatten.mock.calls.length).toBe(first);

    // An edit says so by bumping the version, and then they are rebuilt.
    view.update(object, display, { ...state, meshVersion: state.meshVersion + 1 });
    expect(flatten.mock.calls.length).toBeGreaterThan(first);
    flatten.mockRestore();
  });

  it('leaves the preview to the wireframe itself in object mode', () => {
    const { object, settings } = subdividedBox();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), viewState(settings, 'object'));

    const preview = view.group.getObjectByName(`${object.id}:preview`) as THREE.LineSegments;
    expect(preview.visible).toBe(false);
  });

  it('draws one wireframe with nothing on the stack', () => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addPrimitive('cube');
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
    view.update(object, evaluatedMesh(object), viewState(settings, 'edit'));

    const preview = view.group.getObjectByName(`${object.id}:preview`) as THREE.LineSegments;
    expect(preview.visible).toBe(false);
  });
});

describe('ObjectView origin marker', () => {
  function originOf(view: ObjectView, id: string): THREE.Points {
    return view.group.getObjectByName(`${id}:origin`) as THREE.Points;
  }

  function state(settings: ViewportSettings, isSelected: boolean) {
    return {
      mode: 'object' as const,
      selectMode: 'vertex' as const,
      isActive: isSelected,
      isSelected,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    };
  }

  it('marks a selected object and leaves the rest unmarked', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), state(settings, false));
    expect(originOf(view, object.id).visible).toBe(false);

    view.update(object, evaluatedMesh(object), state(settings, true));
    expect(originOf(view, object.id).visible).toBe(true);

    // Drawn through the mesh it sits inside, unlike every other mark.
    expect((originOf(view, object.id).material as THREE.PointsMaterial).depthTest).toBe(false);
  });

  it('goes away with the overlay', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), {
      ...state(settings, true),
      settings: { ...settings, overlays: { ...settings.overlays, origins: false } },
    });

    expect(originOf(view, object.id).visible).toBe(false);
  });

  it('stays on the group zero while an edit walks the mesh away from it', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);
    view.update(object, evaluatedMesh(object), state(settings, true));

    for (const vert of object.mesh.verts.values()) vert.co = add(vert.co, vec3(0, 3, 0));
    view.update(object, evaluatedMesh(object), state(settings, true));

    // The origin is the group's own zero, and vertices moving in edit mode do
    // not move it: that gap is exactly what the marker is there to show, and
    // what ORIGIN TO GEOMETRY closes.
    const marker = originOf(view, object.id);
    expect([...marker.geometry.getAttribute('position').array]).toEqual([0, 0, 0]);
  });
});

describe('ObjectView vertex fade', () => {
  function fadeOf(view: ObjectView): THREE.LineSegments {
    const lines = view.group.children.filter(
      (child): child is THREE.LineSegments => child instanceof THREE.LineSegments,
    );
    // The first plain line set on the object. The wire and the selected edges
    // are drawn as quads for their depth offset, and the alpha this one runs
    // along a segment is the one thing that cannot be, so it stays a line.
    return lines[0];
  }

  function editState(settings: ViewportSettings, selectMode: 'vertex' | 'edge') {
    return {
      mode: 'edit' as const,
      selectMode,
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    };
  }

  it('runs the selection colour out along the edges a selected vertex owns', () => {
    const { object, settings } = scene();
    const mesh = evaluatedMesh(object);
    const [corner] = [...mesh.verts.values()];
    mesh.selectVert(corner);
    mesh.flushSelection('vertex');

    const view = new ObjectView(object.id);
    view.update(object, mesh, editState(settings, 'vertex'));

    const fade = fadeOf(view);
    expect(fade.visible).toBe(true);

    // A box corner owns three edges, and the fade is carried by the alpha, so
    // the colour attribute has to be four wide for three to read it at all.
    const color = fade.geometry.getAttribute('color');
    expect(color.itemSize).toBe(4);
    expect(color.count).toBe(6);

    const alphas = [...Array(color.count).keys()].map((i) => color.getW(i));
    expect(alphas.filter((alpha) => alpha === 1)).toHaveLength(3);
    expect(alphas.filter((alpha) => alpha === 0)).toHaveLength(3);
  });

  it('stays away with nothing selected, and in the modes that select whole edges', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), editState(settings, 'vertex'));
    expect(fadeOf(view).visible).toBe(false);

    const mesh = evaluatedMesh(object);
    const [corner] = [...mesh.verts.values()];
    mesh.selectVert(corner);
    mesh.flushSelection('vertex');

    view.update(object, mesh, editState(settings, 'edge'));
    expect(fadeOf(view).visible).toBe(false);
  });
});

describe('ObjectView sharp edges', () => {
  function sharpOf(view: ObjectView, id: string): LineSegments2 {
    return view.group.getObjectByName(`${id}:sharp`) as LineSegments2;
  }

  // Instanced quads, one per segment, as the outline above.
  function segmentCount(line: LineSegments2): number {
    return line.geometry.getAttribute('instanceStart')?.count ?? 0;
  }

  function state(settings: ViewportSettings, mode: 'object' | 'edit') {
    return {
      mode,
      selectMode: 'edge' as const,
      isActive: true,
      isSelected: true,
      eye: vec3(0, 0, 10),
      selectionLine: SELECTION_LINE,
      meshVersion: 1,
      settings,
    };
  }

  /** The scene's cube with every edge marked sharp. */
  function sharpScene() {
    const built = scene();
    for (const edge of built.object.mesh.edges.values()) edge.sharp = true;
    return built;
  }

  it('draws them in cyan in edit mode, and leaves object mode to the shading', () => {
    const { object, settings } = sharpScene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), state(settings, 'edit'));
    const sharp = sharpOf(view, object.id);
    expect(sharp.visible).toBe(true);
    expect((sharp.material as LineMaterial).color.getHexString()).toBe('3de0d0');

    view.update(object, evaluatedMesh(object), state(settings, 'object'));
    expect(sharp.visible).toBe(false);
  });

  it('draws nothing on a mesh with no sharp edge', () => {
    const { object, settings } = scene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), state(settings, 'edit'));

    expect(sharpOf(view, object.id).visible).toBe(false);
  });

  it('sits under the selection, so a picked sharp edge still reads as picked', () => {
    const { object } = sharpScene();
    const view = new ObjectView(object.id);
    const lines = view.group.children.filter(
      (child): child is LineSegments2 => child instanceof LineSegments2,
    );
    // The selected edges are the red line set drawn last of the quads.
    const selected = lines.reduce((top, line) => (line.renderOrder > top.renderOrder ? line : top));

    expect(sharpOf(view, object.id).renderOrder).toBeLessThan(selected.renderOrder);
    expect(sharpOf(view, object.id).renderOrder).toBeGreaterThan(0);
  });

  it('leaves out the far side, and re-culls from a new camera without a rebuild', () => {
    const { object, settings } = sharpScene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), state(settings, 'edit'));
    expect(segmentCount(sharpOf(view, object.id))).toBe(4);

    view.refreshForCamera(vec3(10, 10, 10));
    expect(segmentCount(sharpOf(view, object.id))).toBe(9);
  });

  it('keeps every one in x-ray, which is for seeing through the model', () => {
    const { object, settings } = sharpScene();
    const view = new ObjectView(object.id);

    view.update(object, evaluatedMesh(object), state({ ...settings, shading: 'xray' }, 'edit'));

    expect(segmentCount(sharpOf(view, object.id))).toBe(12);
  });
});
