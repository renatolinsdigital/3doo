import * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

import { type BMesh, type Vec3, composeMatrix, inverseTransformPoint } from '@kernel/index';
import { DEFAULT_PREFERENCES } from '@store/index';
import type { SceneObject, SelectMode, ShadingMode, ViewportSettings } from '@store/types';

import {
  POINT_MARK_SIZES,
  VIEWPORT_COLORS,
  createFaceOrientationMaterial,
  createHoverPointMaterial,
  createNormalsMaterial,
  createOriginMaterial,
  createOutlineMaterial,
  createPointMaterial,
  createPreviewWireMaterial,
  createRecentPointMaterial,
  createSelectionOverlayMaterial,
  createSharpWireMaterial,
  createSurfaceMaterial,
  createVertexHighlightMaterial,
  createWireMaterial,
  disposeMaterial,
} from './materials';
import {
  type EdgeBuffers,
  type EdgeCull,
  type EdgeLines,
  NO_EDGE_LINES,
  type PointBuffers,
  type SolidBuffers,
  buildEdgeCull,
  buildMeshBuffers,
  buildNormalLines,
  buildSilhouetteEdges,
  frontEdgeLines,
  frontSharpLines,
} from './meshBuffers';

/**
 * How much the outline darkens on a selected object that is not the active one.
 *
 * Derived from the chosen colour rather than being a second preference: the
 * point is only that a multi-object selection still says which one the
 * operations will run on.
 */
const INACTIVE_OUTLINE_TINT = 0.68;

/**
 * How wide the wireframe is drawn, in device pixels.
 *
 * Not one, though one is what it replaces. A quad antialiases along both of its
 * long edges, and a quad exactly one pixel across spends most of its width on
 * that falloff: measured against the plain line it took over from, it lands at
 * about three quarters of the ink. 1.4 reads as the same line.
 */
const WIRE_WIDTH_DEVICE_PX = 1.4;

/**
 * The wireframe for a finger, in CSS pixels. A device pixel on a phone is a
 * third of a CSS one, so the desktop line all but vanishes there, and an edge
 * has to be seen before it can be tapped.
 */
const TOUCH_WIRE_WIDTH_PX = 1.75;

/** How much bigger the point marks are drawn for a finger than for a mouse. */
const TOUCH_POINT_SCALE = 2.25;

/**
 * A held cull table and what it was built from.
 *
 * Both halves are needed to know it is still good: the modifier stack hands out
 * a new mesh each time it evaluates, while edit-mode operators write into the
 * one mesh in place and say so by bumping the version.
 */
interface CullSlot {
  mesh: BMesh;
  version: number;
  cull: EdgeCull;
}

/**
 * The fade's colour buffer: selection red throughout, alpha from the weights.
 *
 * Four components rather than three because that is how three is told a line
 * carries its own alpha, and the alpha is the whole of the effect: the red is
 * the same red at both ends of every segment.
 */
function vertexHighlightColors(weights: Float32Array): Float32Array {
  const red = new THREE.Color(VIEWPORT_COLORS.red);
  const colors = new Float32Array(weights.length * 4);

  for (let i = 0; i < weights.length; i++) {
    colors[i * 4] = red.r;
    colors[i * 4 + 1] = red.g;
    colors[i * 4 + 2] = red.b;
    colors[i * 4 + 3] = weights[i];
  }

  return colors;
}

export interface ObjectViewState {
  mode: 'object' | 'edit';
  selectMode: SelectMode;
  isActive: boolean;
  isSelected: boolean;
  /** The camera, in world space, for the selection outline's silhouette. */
  eye: Vec3;
  /** Colour and pixel width of the object-mode outline, from the user's preferences. */
  selectionLine: { color: string; width: number };
  settings: ViewportSettings;
  /**
   * The store's mesh version, which says when geometry has actually changed.
   *
   * An edit-mode operator writes into the mesh it was handed, so its identity
   * says nothing about whether the vertices moved. This is what tells the cull
   * tables they are stale.
   */
  meshVersion: number;
  /** Kernel ids of vertices to flash as just-created; empty most of the time. */
  recentVerts?: ReadonlySet<number>;
  /**
   * The picture this object is drawn with, for an image plane.
   *
   * Resolved by the viewport rather than looked up here: the bridge is handed
   * what to draw, and which blob became which texture is the viewport's book
   * to keep.
   */
  texture?: THREE.Texture | null;
}

/** A mesh's materials as a list, however many slots it was built with. */
function surfaceMaterials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/**
 * Whether edit mode draws the stack's edges under the cage.
 *
 * Not for a subdivision surface, which is read from its shading with the cage
 * around it: its own edges run four times denser per level and would bury the
 * surface in wire.
 */
function drawsPreviewWire(object: SceneObject): boolean {
  return !object.modifiers.some((modifier) => modifier.enabled && modifier.type === 'subsurf');
}

/** Everything the surface materials are built from, as one comparable string. */
function solidMaterialKey(object: SceneObject, state: ObjectViewState): string {
  const colours = object.materials.map(
    (material) => `${material.color.r},${material.color.g},${material.color.b}`,
  );
  // The texture's own id, so a picture arriving late rebuilds the material once
  // and a drag over an image plane does not rebuild it at all.
  const image = state.texture?.uuid ?? object.image?.assetId ?? '';
  return [state.settings.shading, state.settings.backfaceCulling, image, ...colours].join('|');
}

/**
 * What an object is drawn as, which is not always what the viewport is set to.
 *
 * An image plane is a picture before it is geometry: four vertices holding up
 * a reference to model against. Wireframe would leave a bare rectangle where
 * the reference was and x-ray would fade it to a ghost, so the shading modes
 * pass an image by and it stays solid however the rest of the scene is drawn.
 * Edit mode still gets its cage, which is drawn whatever the shading says.
 */
function shownState(object: SceneObject, state: ObjectViewState): ObjectViewState {
  if (!object.image || state.settings.shading === 'solid') return state;
  return { ...state, settings: { ...state.settings, shading: 'solid' } };
}

/**
 * The Three.js side of one scene object.
 *
 * React never touches this. The viewport rebuilds it from kernel buffers when
 * the store's mesh version changes, which keeps the scene graph out of the
 * React reconciler entirely.
 */
export class ObjectView {
  readonly group = new THREE.Group();

  private readonly solid = new THREE.Mesh();
  private readonly cage = new THREE.Mesh();
  private readonly backfaces = new THREE.Mesh();
  private readonly wire = new LineSegments2();
  private readonly previewWire = new LineSegments2();
  private readonly vertexHighlight = new THREE.LineSegments();
  private readonly selectedFaces = new THREE.Mesh();
  private readonly sharpEdges = new LineSegments2();
  private readonly selectedEdges = new LineSegments2();
  private readonly points = new THREE.Points();
  private readonly hoverPoint = new THREE.Points();
  private readonly recentPoints = new THREE.Points();
  private readonly normals = new THREE.LineSegments();
  private readonly outline = new LineSegments2();
  private readonly origin = new THREE.Points();

  /** What the surface materials were last built from; see `updateSolid`. */
  private solidMaterialKey = '';

  /** Whether the pick buffers describe the cage rather than the modifier result. */
  private picksCage = false;

  /** The one point the hover mark draws, written in place rather than rebuilt. */
  private readonly hoverPosition = new Float32Array(3);
  /** Whether the current mode has vertices to hover at all. */
  private hoverable = false;

  /** Whether the sharp edges are drawn, which only edit mode does. */
  private marksSharp = false;

  /** Held for `refreshForCamera`, which re-traces the silhouette as the camera moves. */
  private outlined: { mesh: BMesh; object: SceneObject } | null = null;

  /**
   * What the wireframe is culled against, while an opaque surface makes that
   * worth doing. Which edges are on the far side changes with the camera, the
   * same way the outline does, so `refreshForCamera` rebuilds from this.
   */
  private culled: { cage: EdgeCull; preview: EdgeCull | null; object: SceneObject } | null = null;

  /**
   * The cull tables, held between frames for the cage and for the preview.
   *
   * They are flattened out of a mesh and only change when it does, so a camera
   * move reads them and a gizmo drag, which redraws on every pointer move
   * without touching a vertex, does not pay to build them again.
   */
  private readonly cullTables = new Map<'cage' | 'preview', CullSlot>();

  /** The shape the modifier stack made, which is what the preview wire draws. */
  private previewMesh: BMesh | null = null;

  /** Triangle index to kernel face id, for raycast picking. */
  triangleFaceIds: Int32Array = new Int32Array(0);
  vertIds: Int32Array = new Int32Array(0);
  edgeIds: Int32Array = new Int32Array(0);
  vertPositions: Float32Array = new Float32Array(0);
  edgePositions: Float32Array = new Float32Array(0);

  constructor(readonly objectId: string) {
    this.group.name = objectId;
    this.solid.name = `${objectId}:solid`;
    this.solid.userData.objectId = objectId;
    this.previewWire.name = `${objectId}:preview`;
    this.cage.name = `${objectId}:cage`;
    this.cage.userData.objectId = objectId;
    this.outline.name = `${objectId}:outline`;
    this.origin.name = `${objectId}:origin`;
    this.sharpEdges.name = `${objectId}:sharp`;

    // Never drawn: the modifier result is what the user looks at, and this is
    // only here for the ray to hit. Three raycasts a mesh it is handed whether
    // or not it is visible. It hangs off the group so the scene graph keeps its
    // world matrix up to date with the object's transform.
    this.cage.material = new THREE.MeshBasicMaterial();
    this.cage.visible = false;

    this.backfaces.material = createFaceOrientationMaterial();
    this.wire.material = createWireMaterial(false);
    this.previewWire.material = createPreviewWireMaterial();
    this.vertexHighlight.material = createVertexHighlightMaterial();
    this.sharpEdges.material = createSharpWireMaterial();
    this.selectedEdges.material = createWireMaterial(true);
    this.selectedFaces.material = createSelectionOverlayMaterial();
    this.points.material = createPointMaterial();
    this.hoverPoint.material = createHoverPointMaterial();
    this.recentPoints.material = createRecentPointMaterial();
    this.normals.material = createNormalsMaterial();
    this.origin.material = createOriginMaterial();
    this.outline.material = createOutlineMaterial({
      color: DEFAULT_PREFERENCES.selectionLineColor,
      width: DEFAULT_PREFERENCES.selectionLineWidth,
    });

    // Under everything, the plain wireframe included: it is the faintest thing
    // the viewport draws and the cage has to read over it.
    this.previewWire.renderOrder = -1;
    this.outline.renderOrder = 1;
    this.selectedFaces.renderOrder = 2;
    // Under every mark of the selection, so a sharp edge that is picked, or
    // has a picked end, reads as picked first.
    this.sharpEdges.renderOrder = 3;
    // Over the plain wire it lies on and under the fully selected edges, which
    // are the same red without the fade and have to win where the two meet.
    this.vertexHighlight.renderOrder = 4;
    this.selectedEdges.renderOrder = 5;
    this.points.renderOrder = 6;
    // Over the dots, so the mark wins at the depth it shares with the vertex
    // it marks, and over a second vertex sitting in exactly the same place.
    this.hoverPoint.renderOrder = 7;
    this.recentPoints.renderOrder = 8;
    // Last of all, over every mark on the geometry as well as the geometry.
    this.origin.renderOrder = 9;

    // One point, rewritten in place: a hover follows the pointer, and building
    // a geometry per move would churn a buffer a frame. Never culled, since a
    // single point has no bounding sphere worth testing.
    const hover = new THREE.BufferGeometry();
    hover.setAttribute('position', new THREE.BufferAttribute(this.hoverPosition, 3));
    this.hoverPoint.geometry = hover;
    this.hoverPoint.frustumCulled = false;
    this.hoverPoint.visible = false;

    // The origin is the group's own zero, so the marker never moves in here:
    // the transform on the group is what carries it around the scene.
    const marker = new THREE.BufferGeometry();
    marker.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.origin.geometry = marker;
    this.origin.frustumCulled = false;
    this.origin.visible = false;

    this.group.add(
      this.solid,
      this.cage,
      this.backfaces,
      this.wire,
      this.vertexHighlight,
      this.selectedFaces,
      this.sharpEdges,
      this.selectedEdges,
      this.points,
      this.hoverPoint,
      this.recentPoints,
      this.normals,
      this.outline,
      this.previewWire,
      this.origin,
    );
  }

  /**
   * Marks the vertex a click would take, in object space, or clears the mark.
   *
   * Called straight from the viewport as the pointer moves rather than through
   * `update`, which rebuilds every buffer the object has: a hover changes many
   * times a second and nothing else about the object changes with it.
   */
  showHoverVert(position: Vec3 | null): void {
    if (!position || !this.hoverable) {
      this.hoverPoint.visible = false;
      return;
    }

    this.hoverPosition[0] = position.x;
    this.hoverPosition[1] = position.y;
    this.hoverPosition[2] = position.z;
    this.hoverPoint.geometry.getAttribute('position').needsUpdate = true;
    this.hoverPoint.visible = true;
  }

  update(object: SceneObject, displayMesh: BMesh, viewportState: ObjectViewState): void {
    const state = shownState(object, viewportState);
    this.group.visible = object.visible;
    this.group.matrixAutoUpdate = false;
    this.group.matrix.fromArray(composeMatrix(object.transform) as number[]);
    this.group.matrixWorldNeedsUpdate = true;
    if (!object.visible) {
      // Nothing of a hidden object is drawn, outline included, and dropping it
      // here is what stops the camera re-tracing a silhouette nobody can see.
      this.outlined = null;
      this.culled = null;
      this.hoverable = false;
      return;
    }

    const buffers = buildMeshBuffers(displayMesh);

    // Edit mode works on the object's own mesh, so that is what it draws the
    // elements of and what a pick lands on. The modifier stack rebuilds its
    // result from scratch and keeps none of the ids, so a click on the shape on
    // screen named an element the mesh being edited does not have, and selected
    // nothing. The result still shades underneath: the cage is what you hold,
    // the preview is what it makes.
    const cageMesh = state.mode === 'edit' && state.isActive ? object.mesh : displayMesh;
    const cage = cageMesh === displayMesh ? buffers : buildMeshBuffers(cageMesh);
    this.picksCage = cage !== buffers;

    this.triangleFaceIds = cage.solid.triangleFaceIds;
    this.vertIds = cage.points.vertIds;
    this.edgeIds = cage.edges.edgeIds;
    this.vertPositions = cage.points.positions;
    this.edgePositions = cage.edges.positions;

    this.previewMesh = displayMesh;
    this.updateSolid(object, buffers.solid, cage.solid, state);
    this.updateCage(cage.solid, state);
    this.updateWireframe(cage.edges, state, cageMesh, object);
    this.updatePreviewWire(buffers.edges, object, state);
    this.updateOutline(object, displayMesh, state);
    this.updatePoints(cage.points, state);
    this.updateRecentPoints(cage.points, state);
    this.updateNormals(displayMesh, state);
    // The point the object gizmo sits on, so the square says where the handles
    // will be before any tool that has them is picked up, and says where a
    // rotation will turn about once one is. Selected objects only, as Blender's
    // origins overlay does: a square per object in the scene would clutter a
    // view that is mostly not about them.
    this.origin.visible = state.settings.overlays.origins && (state.isSelected || state.isActive);
  }

  private updateSolid(
    object: SceneObject,
    solid: SolidBuffers,
    cage: SolidBuffers,
    state: ObjectViewState,
  ): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(solid.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(solid.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(solid.uvs, 2));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    for (const group of solid.groups) {
      geometry.addGroup(group.start, group.count, group.materialIndex);
    }

    this.replaceGeometry(this.solid, geometry);

    // Surfaces are re-materialised only when something they are built from
    // changes. A gizmo drag runs this on every pointer move, and disposing a
    // material drops three's cached shader program along with the last
    // reference to it, so rebuilding them each tick made the renderer compile
    // the shader again mid-drag, one stutter per frame.
    const materialKey = solidMaterialKey(object, state);
    if (materialKey !== this.solidMaterialKey) {
      disposeMaterial(this.solid.material);
      this.solid.material = (object.materials.length > 0 ? object.materials : [null]).map(
        (material) =>
          createSurfaceMaterial({
            color: material
              ? new THREE.Color(material.color.r, material.color.g, material.color.b)
              : new THREE.Color(VIEWPORT_COLORS.bone),
            shading: state.settings.shading,
            backfaceCulling: state.settings.backfaceCulling,
            map: state.texture ?? null,
          }),
      );
      this.solidMaterialKey = materialKey;
    }

    this.solid.visible = state.settings.shading !== 'wireframe';

    this.backfaces.visible = state.settings.overlays.faceOrientation;
    if (this.backfaces.visible) {
      this.replaceGeometry(this.backfaces, geometry.clone());
    }

    const selection = new THREE.BufferGeometry();
    selection.setAttribute('position', new THREE.BufferAttribute(cage.selectedTriangles, 3));
    this.replaceGeometry(this.selectedFaces, selection);
    this.selectedFaces.visible =
      state.mode === 'edit' && state.isActive && cage.selectedTriangles.length > 0;
  }

  /**
   * The triangles an edit-mode ray tests against, which are never drawn.
   *
   * Positions alone: a ray wants triangles and nothing else. With no modifier
   * on the stack the cage is the mesh already on screen, and the solid answers
   * for it rather than this carrying a second copy of the same geometry.
   */
  private updateCage(cage: SolidBuffers, state: ObjectViewState): void {
    const geometry = new THREE.BufferGeometry();
    if (this.picksCage) {
      geometry.setAttribute('position', new THREE.BufferAttribute(cage.positions, 3));
      geometry.computeBoundingSphere();
    }
    this.replaceGeometry(this.cage, geometry);

    // A face pick has to reach the same faces it would through the surface, so
    // the cage is culled the way the surface is: x-ray draws both sides, and
    // everywhere else the preference decides.
    const material = this.cage.material as THREE.MeshBasicMaterial;
    material.side =
      state.settings.backfaceCulling && state.settings.shading !== 'xray'
        ? THREE.FrontSide
        : THREE.DoubleSide;
  }

  private updateWireframe(
    edges: EdgeBuffers,
    state: ObjectViewState,
    cageMesh: BMesh,
    object: SceneObject,
  ): void {
    const shading: ShadingMode = state.settings.shading;
    const drawsWire =
      shading === 'wireframe' ||
      shading === 'solidWire' ||
      shading === 'xray' ||
      state.mode === 'edit';

    // Only an opaque surface hides a far side, and only then is dropping those
    // edges the same picture with less in it. X-ray and wireframe keep every
    // edge, since seeing through the model is what they are for.
    const culls = drawsWire && shading !== 'wireframe' && shading !== 'xray';
    this.culled = culls
      ? {
          cage: this.cullTableFor('cage', cageMesh, state.meshVersion),
          preview:
            this.picksCage && this.previewMesh && drawsPreviewWire(object)
              ? this.cullTableFor('preview', this.previewMesh, state.meshVersion)
              : null,
          object,
        }
      : null;
    this.setLines(
      this.wire,
      this.culled ? this.frontEdges(this.culled.cage, object, state.eye) : edges,
      drawsWire,
    );

    // Never culled: a selection has to read wherever it is, and an edge picked
    // round the back is one the user chose.
    this.setLines(this.selectedEdges, edges.selected, state.mode === 'edit' && state.isActive);

    // Edit mode alone, on the cage: the mark is there to be edited, and out of
    // edit mode the break in the shading is what shows it. Culled like the
    // wire it lies on rather than like the selection, since it is a property
    // of the mesh and not something the user just picked round the back.
    this.marksSharp = state.mode === 'edit' && state.isActive;
    this.setLines(
      this.sharpEdges,
      !this.marksSharp
        ? NO_EDGE_LINES
        : this.culled
          ? this.frontSharp(this.culled.cage, object, state.eye)
          : edges.sharp,
      this.marksSharp,
    );

    const highlight = new THREE.BufferGeometry();
    highlight.setAttribute('position', new THREE.BufferAttribute(edges.partialPositions, 3));
    highlight.setAttribute(
      'color',
      new THREE.BufferAttribute(vertexHighlightColors(edges.partialWeights), 4),
    );
    this.replaceGeometry(this.vertexHighlight, highlight);
    // Vertex mode alone. Edge and face mode take whole edges, so an edge with
    // one end selected there is one the user never picked, and marking it says
    // the selection reaches somewhere it does not.
    this.vertexHighlight.visible =
      state.mode === 'edit' &&
      state.isActive &&
      state.selectMode === 'vertex' &&
      edges.partialPositions.length > 0;
  }

  /**
   * The edges of the shape the stack is making, drawn under the cage.
   *
   * Only while the two differ, which is edit mode with a modifier on the stack:
   * everywhere else the wireframe is already the shape on screen, and drawing
   * it twice would only darken it. A subdivision that cuts faces without
   * moving them changes nothing else about the picture, so without this edit
   * mode gives no sign the modifier is there at all.
   */
  private updatePreviewWire(edges: EdgeBuffers, object: SceneObject, state: ObjectViewState): void {
    if (!this.picksCage || !drawsPreviewWire(object)) {
      this.setLines(this.previewWire, NO_EDGE_LINES, false);
      return;
    }

    const preview = this.culled?.preview;
    this.setLines(
      this.previewWire,
      preview ? this.frontEdges(preview, object, state.eye) : edges,
      true,
    );
  }

  /**
   * Traces the object's outline, the way Blender marks a selection.
   *
   * Only the silhouette, not every edge: the wireframe already says where the
   * geometry runs, and an outline is about which object you are holding. The
   * active one is redder than the rest of the selection, so a multi-object
   * selection still says which one the operations will run on.
   */
  private updateOutline(object: SceneObject, mesh: BMesh, state: ObjectViewState): void {
    this.outline.visible = state.mode === 'object' && state.isSelected;
    this.outlined = this.outline.visible ? { mesh, object } : null;

    // The fill stamps the stencil that keeps the line off the object's own
    // pixels, and only while there is a line to keep off: a stencil test costs
    // nothing to switch, unlike rebuilding a material, which drops its shader.
    for (const material of surfaceMaterials(this.solid)) {
      material.stencilWrite = this.outline.visible;
    }
    if (!this.outline.visible) return;

    const material = this.outline.material as LineMaterial;
    material.color.set(state.selectionLine.color);
    if (!state.isActive) material.color.multiplyScalar(INACTIVE_OUTLINE_TINT);
    // Doubled, because the stencil eats the half of it lying over the object:
    // what is left is the outer half, and the preference is about what shows.
    material.linewidth = state.selectionLine.width * 2;
    this.traceOutline(state.eye);
  }

  /**
   * Tells the line shaders how large the viewport is, in CSS pixels, and how
   * many device pixels one of those covers.
   *
   * A pixel width means nothing to a vertex shader working in clip space, so
   * `LineMaterial` divides by the resolution. Left at its `(1, 1)` default
   * every line drawn as quads, the wireframe included, comes out wider than
   * the screen.
   *
   * The wire asks in **device** pixels, since that is what a plain line drew
   * and what the viewport is still meant to look like. A width given in CSS
   * pixels comes out that much heavier on every display with more than one
   * device pixel to them. The outline is left alone: its width is a user
   * preference, given in the CSS pixels the preference is written in.
   *
   * `touch` draws the wire and the point marks for a finger instead.
   */
  setResolution(width: number, height: number, pixelRatio: number, touch = false): void {
    for (const line of [
      this.outline,
      this.wire,
      this.sharpEdges,
      this.selectedEdges,
      this.previewWire,
    ]) {
      (line.material as LineMaterial).resolution.set(width, height);
    }
    const wireWidth = touch ? TOUCH_WIRE_WIDTH_PX : WIRE_WIDTH_DEVICE_PX / Math.max(1, pixelRatio);
    for (const line of [this.wire, this.sharpEdges, this.selectedEdges, this.previewWire]) {
      (line.material as LineMaterial).linewidth = wireWidth;
    }

    const scale = touch ? TOUCH_POINT_SCALE : 1;
    const marks: [THREE.Points, number][] = [
      [this.points, POINT_MARK_SIZES.vertex],
      [this.hoverPoint, POINT_MARK_SIZES.hover],
      [this.recentPoints, POINT_MARK_SIZES.recent],
      [this.origin, POINT_MARK_SIZES.origin],
    ];
    for (const [points, size] of marks) {
      (points.material as THREE.PointsMaterial).size = size * scale;
    }
  }

  /**
   * Redraws what depends on where the camera stands.
   *
   * Two things do: which edges are on the silhouette the outline traces, and
   * which are on the far side and so left out of the wireframe. Orbiting
   * changes both even when nothing in the scene has moved.
   */
  refreshForCamera(eye: Vec3): void {
    if (this.outlined) this.traceOutline(eye);
    if (!this.culled) return;

    // A set can empty and fill again as the camera turns around a mesh, so both
    // are handed back the visibility they were drawn with rather than whatever
    // the last position of the camera left them at.
    const { cage, preview, object } = this.culled;
    this.setLines(this.wire, this.frontEdges(cage, object, eye), true);
    if (preview) {
      this.setLines(this.previewWire, this.frontEdges(preview, object, eye), true);
    }
    if (this.marksSharp) {
      this.setLines(this.sharpEdges, this.frontSharp(cage, object, eye), true);
    }
  }

  /** The mesh's edges minus the ones lying on its far side, in object space. */
  private frontEdges(cull: EdgeCull, object: SceneObject, eye: Vec3): EdgeLines {
    return frontEdgeLines(cull, inverseTransformPoint(object.transform, eye));
  }

  /** The same for the sharp edges alone. */
  private frontSharp(cull: EdgeCull, object: SceneObject, eye: Vec3): EdgeLines {
    return frontSharpLines(cull, inverseTransformPoint(object.transform, eye));
  }

  /** The cull table for a mesh, flattened again only once the mesh has moved on. */
  private cullTableFor(slot: 'cage' | 'preview', mesh: BMesh, version: number): EdgeCull {
    const held = this.cullTables.get(slot);
    if (held && held.mesh === mesh && held.version === version) return held.cull;

    const cull = buildEdgeCull(mesh);
    this.cullTables.set(slot, { mesh, version, cull });
    return cull;
  }

  /**
   * Hands a line set to a `LineSegments2`, which wants its own geometry type.
   *
   * The face normals either side of each edge ride along as two more instance
   * attributes, which is what the wire's lift sizes itself by (see
   * `liftWire`).
   *
   * An empty one is left without positions, and hidden: an instanced geometry
   * with no instances has no bounding sphere for the frustum check to work
   * with. Whether it comes back is the caller's to say, since a set can empty
   * and fill again as the camera turns around a mesh.
   */
  private setLines(line: LineSegments2, lines: EdgeLines, visible: boolean): void {
    const geometry = new LineSegmentsGeometry();
    if (lines.positions.length > 0) {
      geometry.setPositions(lines.positions);
      const sides = new THREE.InstancedInterleavedBuffer(lines.sides, 6, 1);
      geometry.setAttribute('instanceSideA', new THREE.InterleavedBufferAttribute(sides, 3, 0));
      geometry.setAttribute('instanceSideB', new THREE.InterleavedBufferAttribute(sides, 3, 3));
    }
    this.replaceGeometry(line, geometry);
    line.visible = visible && lines.positions.length > 0;
  }

  private traceOutline(eye: Vec3): void {
    const outlined = this.outlined;
    if (!outlined) return;

    const positions = buildSilhouetteEdges(
      outlined.mesh,
      inverseTransformPoint(outlined.object.transform, eye),
    );

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    this.replaceGeometry(this.outline, geometry);
    // A mesh with no faces has no silhouette, and an empty instanced geometry
    // has no bounding sphere for the frustum check to work with.
    this.outline.visible = positions.length > 0;
  }

  private updatePoints(points: PointBuffers, state: ObjectViewState): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(points.positions, 3));

    const colors = new Float32Array(points.selection.length * 3);
    for (let i = 0; i < points.selection.length; i++) {
      const isSelected = points.selection[i] > 0.5;
      colors[i * 3] = isSelected ? 0.9 : 0.05;
      colors[i * 3 + 1] = isSelected ? 0.2 : 0.05;
      colors[i * 3 + 2] = isSelected ? 0.16 : 0.05;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.replaceGeometry(this.points, geometry);
    // Only vertex mode can act on vertices, so drawing them in edge/face mode
    // is noise sitting on top of the elements actually being selected.
    this.points.visible = state.mode === 'edit' && state.isActive && state.selectMode === 'vertex';

    // The hover mark belongs to the dots it grows out of, and goes away with
    // them. The viewport puts it back on the next pointer move or resync.
    this.hoverable = this.points.visible;
    if (!this.hoverable) this.hoverPoint.visible = false;
  }

  /**
   * Marks the vertices an operator just made.
   *
   * Kept separate from `points` rather than recoloured inside it, because it
   * has to show in edge and face mode too, where that object is hidden.
   */
  private updateRecentPoints(points: PointBuffers, state: ObjectViewState): void {
    const recent = state.recentVerts;
    this.recentPoints.visible = state.mode === 'edit' && state.isActive && !!recent?.size;
    if (!this.recentPoints.visible || !recent) return;

    const positions: number[] = [];
    for (let i = 0; i < points.vertIds.length; i++) {
      if (!recent.has(points.vertIds[i])) continue;
      positions.push(
        points.positions[i * 3],
        points.positions[i * 3 + 1],
        points.positions[i * 3 + 2],
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.replaceGeometry(this.recentPoints, geometry);
    this.recentPoints.visible = positions.length > 0;
  }

  private updateNormals(displayMesh: BMesh, state: ObjectViewState): void {
    this.normals.visible = state.settings.overlays.normals;
    if (!this.normals.visible) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buildNormalLines(displayMesh), 3));
    this.replaceGeometry(this.normals, geometry);
  }

  private replaceGeometry(target: THREE.Object3D, geometry: THREE.BufferGeometry): void {
    const holder = target as THREE.Object3D & { geometry?: THREE.BufferGeometry };
    holder.geometry?.dispose();
    holder.geometry = geometry;
  }

  /**
   * What raycasting tests against: the shape on screen, or the cage under it.
   *
   * They are the same mesh until a modifier is on the stack, and in edit mode
   * they part company: a face pick has to name a face of the mesh being edited,
   * not one of the result the stack built out of it.
   */
  get pickTarget(): THREE.Mesh {
    return this.picksCage ? this.cage : this.solid;
  }

  /**
   * The shape on screen, whatever is being picked.
   *
   * Compared against `pickTarget` it answers whether a modifier is standing
   * between the two, and on its own it answers whether the pointer is over the
   * object at all, which a pick against the cage cannot say.
   */
  get surfaceTarget(): THREE.Mesh {
    return this.solid;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((child) => {
      const holder = child as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      holder.geometry?.dispose();
      if (holder.material) disposeMaterial(holder.material);
    });
  }
}
