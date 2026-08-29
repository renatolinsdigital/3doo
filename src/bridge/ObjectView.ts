import * as THREE from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

import { type BMesh, type Vec3, composeMatrix, inverseTransformPoint } from '@kernel/index';
import { DEFAULT_PREFERENCES } from '@store/index';
import type { SceneObject, SelectMode, ShadingMode, ViewportSettings } from '@store/types';

import {
  VIEWPORT_COLORS,
  createFaceOrientationMaterial,
  createHoverPointMaterial,
  createNormalsMaterial,
  createOutlineMaterial,
  createPointMaterial,
  createRecentPointMaterial,
  createSelectionOverlayMaterial,
  createSurfaceMaterial,
  createWireMaterial,
  disposeMaterial,
} from './materials';
import { buildMeshBuffers, buildNormalLines, buildSilhouetteEdges } from './meshBuffers';

/**
 * How much the outline darkens on a selected object that is not the active one.
 *
 * Derived from the chosen colour rather than being a second preference: the
 * point is only that a multi-object selection still says which one the
 * operations will run on.
 */
const INACTIVE_OUTLINE_TINT = 0.68;

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
  /** Kernel ids of vertices to flash as just-created; empty most of the time. */
  recentVerts?: ReadonlySet<number>;
}

/** A mesh's materials as a list, however many slots it was built with. */
function surfaceMaterials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** Everything the surface materials are built from, as one comparable string. */
function solidMaterialKey(object: SceneObject, state: ObjectViewState): string {
  const colours = object.materials.map(
    (material) => `${material.color.r},${material.color.g},${material.color.b}`,
  );
  return [state.settings.shading, state.settings.backfaceCulling, ...colours].join('|');
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
  private readonly backfaces = new THREE.Mesh();
  private readonly wire = new THREE.LineSegments();
  private readonly selectedFaces = new THREE.Mesh();
  private readonly selectedEdges = new THREE.LineSegments();
  private readonly points = new THREE.Points();
  private readonly hoverPoint = new THREE.Points();
  private readonly recentPoints = new THREE.Points();
  private readonly normals = new THREE.LineSegments();
  private readonly outline = new LineSegments2();

  /** What the surface materials were last built from; see `updateSolid`. */
  private solidMaterialKey = '';

  /** The one point the hover mark draws, written in place rather than rebuilt. */
  private readonly hoverPosition = new Float32Array(3);
  /** Whether the current mode has vertices to hover at all. */
  private hoverable = false;

  /** Held for `refreshOutline`, which re-traces the silhouette as the camera moves. */
  private outlined: { mesh: BMesh; object: SceneObject } | null = null;

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
    this.outline.name = `${objectId}:outline`;

    this.backfaces.material = createFaceOrientationMaterial();
    this.wire.material = createWireMaterial(false);
    this.selectedEdges.material = createWireMaterial(true);
    this.selectedFaces.material = createSelectionOverlayMaterial();
    this.points.material = createPointMaterial();
    this.hoverPoint.material = createHoverPointMaterial();
    this.recentPoints.material = createRecentPointMaterial();
    this.normals.material = createNormalsMaterial();
    this.outline.material = createOutlineMaterial({
      color: DEFAULT_PREFERENCES.selectionLineColor,
      width: DEFAULT_PREFERENCES.selectionLineWidth,
    });

    this.outline.renderOrder = 1;
    this.selectedFaces.renderOrder = 2;
    this.selectedEdges.renderOrder = 3;
    this.points.renderOrder = 4;
    // Over the dots, so the mark wins at the depth it shares with the vertex
    // it marks, and over a second vertex sitting in exactly the same place.
    this.hoverPoint.renderOrder = 5;
    this.recentPoints.renderOrder = 6;

    // One point, rewritten in place: a hover follows the pointer, and building
    // a geometry per move would churn a buffer a frame. Never culled, since a
    // single point has no bounding sphere worth testing.
    const hover = new THREE.BufferGeometry();
    hover.setAttribute('position', new THREE.BufferAttribute(this.hoverPosition, 3));
    this.hoverPoint.geometry = hover;
    this.hoverPoint.frustumCulled = false;
    this.hoverPoint.visible = false;

    this.group.add(
      this.solid,
      this.backfaces,
      this.wire,
      this.selectedFaces,
      this.selectedEdges,
      this.points,
      this.hoverPoint,
      this.recentPoints,
      this.normals,
      this.outline,
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

  update(object: SceneObject, displayMesh: BMesh, state: ObjectViewState): void {
    this.group.visible = object.visible;
    this.group.matrixAutoUpdate = false;
    this.group.matrix.fromArray(composeMatrix(object.transform) as number[]);
    this.group.matrixWorldNeedsUpdate = true;
    if (!object.visible) {
      // Nothing of a hidden object is drawn, outline included, and dropping it
      // here is what stops the camera re-tracing a silhouette nobody can see.
      this.outlined = null;
      this.hoverable = false;
      return;
    }

    const buffers = buildMeshBuffers(displayMesh);
    this.triangleFaceIds = buffers.solid.triangleFaceIds;
    this.vertIds = buffers.points.vertIds;
    this.edgeIds = buffers.edges.edgeIds;
    this.vertPositions = buffers.points.positions;
    this.edgePositions = buffers.edges.positions;

    this.updateSolid(object, buffers.solid, state);
    this.updateWireframe(buffers.edges, state);
    this.updateOutline(object, displayMesh, state);
    this.updatePoints(buffers.points, state);
    this.updateRecentPoints(buffers.points, state);
    this.updateNormals(displayMesh, state);
  }

  private updateSolid(
    object: SceneObject,
    solid: ReturnType<typeof buildMeshBuffers>['solid'],
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
    selection.setAttribute('position', new THREE.BufferAttribute(solid.selectedTriangles, 3));
    this.replaceGeometry(this.selectedFaces, selection);
    this.selectedFaces.visible =
      state.mode === 'edit' && state.isActive && solid.selectedTriangles.length > 0;
  }

  private updateWireframe(
    edges: ReturnType<typeof buildMeshBuffers>['edges'],
    state: ObjectViewState,
  ): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(edges.positions, 3));
    this.replaceGeometry(this.wire, geometry);

    const shading: ShadingMode = state.settings.shading;
    this.wire.visible =
      shading === 'wireframe' ||
      shading === 'solidWire' ||
      shading === 'xray' ||
      state.mode === 'edit';

    const selected = new THREE.BufferGeometry();
    selected.setAttribute('position', new THREE.BufferAttribute(edges.selectedPositions, 3));
    this.replaceGeometry(this.selectedEdges, selected);
    this.selectedEdges.visible =
      state.mode === 'edit' && state.isActive && edges.selectedPositions.length > 0;

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
   * Tells the outline shader how large the viewport is, in CSS pixels.
   *
   * A pixel width means nothing to a vertex shader working in clip space, so
   * `LineMaterial` divides by this. Left at its `(1, 1)` default the outline
   * comes out wider than the screen.
   */
  setResolution(width: number, height: number): void {
    (this.outline.material as LineMaterial).resolution.set(width, height);
  }

  /**
   * Re-traces the outline from a new camera position.
   *
   * A silhouette depends on where it is seen from, so orbiting changes which
   * edges are on it even when nothing in the scene has moved.
   */
  refreshOutline(eye: Vec3): void {
    if (!this.outlined) return;
    this.traceOutline(eye);
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

  private updatePoints(
    points: ReturnType<typeof buildMeshBuffers>['points'],
    state: ObjectViewState,
  ): void {
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
  private updateRecentPoints(
    points: ReturnType<typeof buildMeshBuffers>['points'],
    state: ObjectViewState,
  ): void {
    const recent = state.recentVerts;
    this.recentPoints.visible = state.mode === 'edit' && state.isActive && !!recent?.size;
    if (!this.recentPoints.visible || !recent) return;

    const positions: number[] = [];
    for (let i = 0; i < points.vertIds.length; i++) {
      if (!recent.has(points.vertIds[i])) continue;
      positions.push(points.positions[i * 3], points.positions[i * 3 + 1], points.positions[i * 3 + 2]);
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

  /** The solid mesh is what raycasting tests against. */
  get pickTarget(): THREE.Mesh {
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
