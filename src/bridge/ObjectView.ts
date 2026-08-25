import * as THREE from 'three';

import { type BMesh, composeMatrix } from '@kernel/index';
import type { SceneObject, SelectMode, ShadingMode, ViewportSettings } from '@store/types';

import {
  VIEWPORT_COLORS,
  createFaceOrientationMaterial,
  createNormalsMaterial,
  createPointMaterial,
  createRecentPointMaterial,
  createSelectionOverlayMaterial,
  createSurfaceMaterial,
  createWireMaterial,
  disposeMaterial,
} from './materials';
import { buildMeshBuffers, buildNormalLines } from './meshBuffers';

export interface ObjectViewState {
  mode: 'object' | 'edit';
  selectMode: SelectMode;
  isActive: boolean;
  isSelected: boolean;
  settings: ViewportSettings;
  /** Kernel ids of vertices to flash as just-created; empty most of the time. */
  recentVerts?: ReadonlySet<number>;
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
  private readonly recentPoints = new THREE.Points();
  private readonly normals = new THREE.LineSegments();
  private readonly outline = new THREE.LineSegments();

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

    this.backfaces.material = createFaceOrientationMaterial();
    this.wire.material = createWireMaterial(false);
    this.selectedEdges.material = createWireMaterial(true);
    this.selectedFaces.material = createSelectionOverlayMaterial();
    this.points.material = createPointMaterial();
    this.recentPoints.material = createRecentPointMaterial();
    this.normals.material = createNormalsMaterial();
    this.outline.material = new THREE.LineBasicMaterial({ color: VIEWPORT_COLORS.amber });

    this.selectedFaces.renderOrder = 2;
    this.selectedEdges.renderOrder = 3;
    this.points.renderOrder = 4;
    this.recentPoints.renderOrder = 5;

    this.group.add(
      this.solid,
      this.backfaces,
      this.wire,
      this.selectedFaces,
      this.selectedEdges,
      this.points,
      this.recentPoints,
      this.normals,
      this.outline,
    );
  }

  update(object: SceneObject, displayMesh: BMesh, state: ObjectViewState): void {
    this.group.visible = object.visible;
    this.group.matrixAutoUpdate = false;
    this.group.matrix.fromArray(composeMatrix(object.transform) as number[]);
    this.group.matrixWorldNeedsUpdate = true;
    if (!object.visible) return;

    const buffers = buildMeshBuffers(displayMesh);
    this.triangleFaceIds = buffers.solid.triangleFaceIds;
    this.vertIds = buffers.points.vertIds;
    this.edgeIds = buffers.edges.edgeIds;
    this.vertPositions = buffers.points.positions;
    this.edgePositions = buffers.edges.positions;

    this.updateSolid(object, buffers.solid, state);
    this.updateWireframe(buffers.edges, state);
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

    const materials = (object.materials.length > 0 ? object.materials : [null]).map((material) =>
      createSurfaceMaterial({
        color: material
          ? new THREE.Color(material.color.r, material.color.g, material.color.b)
          : new THREE.Color(VIEWPORT_COLORS.bone),
        shading: state.settings.shading,
        backfaceCulling: state.settings.backfaceCulling,
      }),
    );

    this.replaceGeometry(this.solid, geometry);
    disposeMaterial(this.solid.material);
    this.solid.material = materials;
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

    // In object mode the whole object is outlined instead of per-element.
    this.replaceGeometry(this.outline, geometry.clone());
    this.outline.visible = state.mode === 'object' && state.isSelected;
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
