import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

import { ObjectView, VIEWPORT_COLORS } from '@bridge/index';
import {
  type SelectMode,
  medianPoint,
  selectEdgeLoop,
  translateVerts,
  vec3,
} from '@kernel/index';
import { evaluatedMesh, useEditorStore } from '@store/index';
import type { SceneObject } from '@store/types';

import { CameraController } from './CameraController';
import { ViewportGrid } from './grid';
import { type BoxSelectRect, pickElement, pickInRectangle } from './picking';

/**
 * Three.js owns everything in here: the renderer, camera, gizmo, picking and
 * overlays. It is created once against a canvas ref and never re-rendered by
 * React; it reads the store through `subscribeWithSelector` and pushes
 * selection changes back through store actions.
 */
export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private perspectiveCamera: THREE.PerspectiveCamera;
  private orthographicCamera: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;

  private readonly controls: CameraController;
  private readonly gizmo: TransformControls;
  private readonly gizmoHelper: THREE.Object3D;
  private readonly gizmoProxy = new THREE.Object3D();
  private readonly grid = new ViewportGrid();
  private readonly cursor: THREE.Object3D;
  private readonly raycaster = new THREE.Raycaster();

  private readonly views = new Map<string, ObjectView>();
  private readonly unsubscribers: (() => void)[] = [];
  private frameHandle = 0;
  private disposed = false;

  private dragStart: THREE.Vector2 | null = null;
  private dragCurrent: THREE.Vector2 | null = null;
  private gizmoBaseline: THREE.Vector3 | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly overlay: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(VIEWPORT_COLORS.ash);

    const { clientWidth, clientHeight } = canvas;
    const aspect = clientHeight > 0 ? clientWidth / clientHeight : 1;

    this.perspectiveCamera = new THREE.PerspectiveCamera(50, aspect, 0.05, 2000);
    this.orthographicCamera = new THREE.OrthographicCamera(-5 * aspect, 5 * aspect, 5, -5, -1000, 2000);
    this.camera = this.perspectiveCamera;

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(4, 8, 6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffe7d0, 0.5);
    fill.position.set(-6, 2, -4);
    this.scene.add(fill);

    this.scene.add(this.grid.group);
    this.cursor = this.createCursor();
    this.scene.add(this.cursor);
    this.scene.add(this.gizmoProxy);

    this.controls = new CameraController(this.camera, canvas);
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmoHelper = resolveGizmoHelper(this.gizmo);
    this.scene.add(this.gizmoHelper);
    this.gizmo.enabled = false;
    this.gizmoHelper.visible = false;

    this.bindEvents();
    this.subscribeToStore();
    this.syncScene();
    this.resize();
    this.renderLoop();
  }

  // ------------------------------------------------------------------ setup

  private createCursor(): THREE.Object3D {
    const group = new THREE.Group();
    const size = 0.35;
    const positions = new Float32Array([
      -size, 0, 0, size, 0, 0, 0, -size, 0, 0, size, 0, 0, 0, -size, 0, 0, size,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    group.add(
      new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color: VIEWPORT_COLORS.amber, depthTest: false }),
      ),
    );
    group.renderOrder = 10;
    return group;
  }

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);

    this.gizmo.addEventListener('dragging-changed', this.handleGizmoDragging);
    this.gizmo.addEventListener('objectChange', this.handleGizmoChange);
  }

  private subscribeToStore(): void {
    const store = useEditorStore;

    this.unsubscribers.push(
      store.subscribe(
        (state) => state.meshVersion,
        () => this.syncScene(),
      ),
      store.subscribe(
        (state) => [state.mode, state.activeObjectId, state.selectedObjectIds] as const,
        () => this.syncScene(),
        { equalityFn: shallowArrayEqual },
      ),
      store.subscribe(
        (state) =>
          [
            state.shading,
            state.backfaceCulling,
            state.overlays.normals,
            state.overlays.faceOrientation,
          ] as const,
        () => this.syncScene(),
        { equalityFn: shallowArrayEqual },
      ),
      store.subscribe(
        (state) => [state.overlays.grid, state.overlays.axes] as const,
        ([grid, axes]) => this.grid.setVisibility(grid, axes),
        { equalityFn: shallowArrayEqual, fireImmediately: true },
      ),
      store.subscribe(
        (state) => state.cursor,
        (cursor) => this.cursor.position.set(cursor.x, cursor.y, cursor.z),
        { fireImmediately: true },
      ),
      store.subscribe(
        (state) => state.navigation,
        (preset) => {
          this.controls.preset = preset;
        },
        { fireImmediately: true },
      ),
      store.subscribe(
        (state) =>
          [state.orthographic, state.focalLength, state.clipStart, state.clipEnd] as const,
        () => this.applyCameraSettings(),
        { equalityFn: shallowArrayEqual, fireImmediately: true },
      ),
      store.subscribe(
        (state) => state.activeTool,
        () => this.updateGizmo(),
      ),
      store.subscribe(
        (state) => state.frameRequest,
        (request) => {
          if (request) this.frame(request.target);
        },
      ),
      store.subscribe(
        (state) => state.axisViewRequest,
        (request) => {
          if (request) this.controls.setAxisView(request.axis, request.negative);
        },
      ),
    );
  }

  // ------------------------------------------------------------ scene sync

  /** Rebuilds every object's GPU buffers from the kernel meshes. */
  syncScene(): void {
    const state = useEditorStore.getState();
    const settings = {
      shading: state.shading,
      overlays: state.overlays,
      backfaceCulling: state.backfaceCulling,
      orthographic: state.orthographic,
      focalLength: state.focalLength,
      clipStart: state.clipStart,
      clipEnd: state.clipEnd,
      navigation: state.navigation,
    };

    const alive = new Set<string>();
    for (const object of state.objects) {
      alive.add(object.id);
      let view = this.views.get(object.id);
      if (!view) {
        view = new ObjectView(object.id);
        this.views.set(object.id, view);
        this.scene.add(view.group);
      }

      view.update(object, evaluatedMesh(object), {
        mode: state.mode,
        isActive: object.id === state.activeObjectId,
        isSelected: state.selectedObjectIds.includes(object.id),
        settings,
      });
    }

    for (const [id, view] of this.views) {
      if (alive.has(id)) continue;
      view.dispose();
      this.views.delete(id);
    }

    this.updateGizmo();
  }

  private applyCameraSettings(): void {
    const state = useEditorStore.getState();
    const aspect = this.canvas.clientHeight > 0 ? this.canvas.clientWidth / this.canvas.clientHeight : 1;

    this.perspectiveCamera.fov = focalLengthToFov(state.focalLength);
    this.perspectiveCamera.near = state.clipStart;
    this.perspectiveCamera.far = state.clipEnd;
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();

    this.orthographicCamera.near = -state.clipEnd;
    this.orthographicCamera.far = state.clipEnd;
    this.orthographicCamera.updateProjectionMatrix();

    const next = state.orthographic ? this.orthographicCamera : this.perspectiveCamera;
    if (next !== this.camera) {
      this.camera = next;
      this.controls.setCamera(next);
      this.gizmo.camera = next;
    }
  }

  // -------------------------------------------------------------- gizmo

  private updateGizmo(): void {
    const state = useEditorStore.getState();
    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    const modeMap = { move: 'translate', rotate: 'rotate', scale: 'scale' } as const;
    const gizmoMode = modeMap[state.activeTool as keyof typeof modeMap];

    if (!object || object.locked || !gizmoMode) {
      this.gizmo.detach();
      this.gizmo.enabled = false;
      this.gizmoHelper.visible = false;
      return;
    }

    this.gizmo.setMode(gizmoMode);
    this.gizmo.enabled = true;
    this.gizmoHelper.visible = true;

    if (state.mode === 'object') {
      this.gizmoProxy.position.set(
        object.transform.position.x,
        object.transform.position.y,
        object.transform.position.z,
      );
      this.gizmoProxy.rotation.set(
        object.transform.rotation.x,
        object.transform.rotation.y,
        object.transform.rotation.z,
      );
      this.gizmoProxy.scale.set(
        object.transform.scale.x,
        object.transform.scale.y,
        object.transform.scale.z,
      );
    } else {
      // In edit mode the gizmo drives the selection's median point, and the
      // delta is applied to the selected vertices.
      const selected = object.mesh.selectedVerts();
      if (selected.length === 0) {
        this.gizmo.detach();
        this.gizmoHelper.visible = false;
        return;
      }
      const median = medianPoint(selected);
      const local = new THREE.Vector3(median.x, median.y, median.z).applyMatrix4(
        this.views.get(object.id)?.group.matrix ?? new THREE.Matrix4(),
      );
      this.gizmoProxy.position.copy(local);
      this.gizmoProxy.rotation.set(0, 0, 0);
      this.gizmoProxy.scale.set(1, 1, 1);
    }

    this.gizmoBaseline = this.gizmoProxy.position.clone();
    this.gizmo.attach(this.gizmoProxy);
  }

  private handleGizmoDragging = (event: { value: unknown }): void => {
    const dragging = event.value === true;
    const state = useEditorStore.getState();

    if (dragging) {
      this.gizmoBaseline = this.gizmoProxy.position.clone();
      state.recordHistory(state.mode === 'object' ? 'Transform object' : 'Move selection');
      return;
    }
    state.touchMesh();
  };

  private handleGizmoChange = (): void => {
    const state = useEditorStore.getState();
    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    if (!object) return;

    if (state.mode === 'object') {
      state.setObjectTransform(object.id, {
        position: vec3(
          this.gizmoProxy.position.x,
          this.gizmoProxy.position.y,
          this.gizmoProxy.position.z,
        ),
        rotation: vec3(
          this.gizmoProxy.rotation.x,
          this.gizmoProxy.rotation.y,
          this.gizmoProxy.rotation.z,
        ),
        scale: vec3(this.gizmoProxy.scale.x, this.gizmoProxy.scale.y, this.gizmoProxy.scale.z),
      });
      return;
    }

    if (!this.gizmoBaseline) return;
    const delta = this.gizmoProxy.position.clone().sub(this.gizmoBaseline);
    if (delta.lengthSq() < 1e-12) return;

    // The gizmo drags in world space; the mesh edit is in object space, so undo
    // the object's scale before applying the delta to the vertices.
    const scale = object.transform.scale;
    const localDelta = new THREE.Vector3(
      delta.x / (scale.x || 1),
      delta.y / (scale.y || 1),
      delta.z / (scale.z || 1),
    );

    translateVerts(
      object.mesh,
      object.mesh.selectedVerts(),
      vec3(localDelta.x, localDelta.y, localDelta.z),
      state.proportional,
    );
    this.gizmoBaseline = this.gizmoProxy.position.clone();
    state.touchMesh();
  };

  // ------------------------------------------------------------- pointer

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.gizmo.dragging) return;
    if (this.controls.onPointerDown(event)) return;
    if (event.button !== 0) return;

    this.dragStart = this.pointerPosition(event);
    this.dragCurrent = this.dragStart.clone();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.controls.onPointerMove(event)) return;
    if (!this.dragStart) return;

    this.dragCurrent = this.pointerPosition(event);
    this.drawSelectionRectangle();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const wasNavigating = this.controls.isNavigating;
    this.controls.onPointerUp(event);
    if (wasNavigating) return;
    if (!this.dragStart || !this.dragCurrent) return;

    const start = this.dragStart;
    const end = this.dragCurrent;
    this.dragStart = null;
    this.dragCurrent = null;
    this.overlay.style.display = 'none';

    const isBox = start.distanceTo(end) > 4;
    if (isBox) {
      this.boxSelect(
        {
          minX: Math.min(start.x, end.x),
          minY: Math.min(start.y, end.y),
          maxX: Math.max(start.x, end.x),
          maxY: Math.max(start.y, end.y),
        },
        event.shiftKey,
      );
      return;
    }

    this.clickSelect(end, event.shiftKey, event.altKey);
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.controls.onWheel(event);
  };

  private handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private pointerPosition(event: PointerEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
  }

  private drawSelectionRectangle(): void {
    if (!this.dragStart || !this.dragCurrent) return;
    if (this.dragStart.distanceTo(this.dragCurrent) < 4) return;

    const minX = Math.min(this.dragStart.x, this.dragCurrent.x);
    const minY = Math.min(this.dragStart.y, this.dragCurrent.y);
    this.overlay.style.display = 'block';
    this.overlay.style.left = `${minX}px`;
    this.overlay.style.top = `${minY}px`;
    this.overlay.style.width = `${Math.abs(this.dragCurrent.x - this.dragStart.x)}px`;
    this.overlay.style.height = `${Math.abs(this.dragCurrent.y - this.dragStart.y)}px`;
  }

  private updateRaycaster(pointer: THREE.Vector2): void {
    const ndc = new THREE.Vector2(
      (pointer.x / this.canvas.clientWidth) * 2 - 1,
      -(pointer.y / this.canvas.clientHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  private clickSelect(pointer: THREE.Vector2, additive: boolean, loopSelect: boolean): void {
    const state = useEditorStore.getState();
    this.updateRaycaster(pointer);

    if (state.mode === 'object') {
      const targets = state.objects
        .filter((object) => object.visible)
        .map((object) => this.views.get(object.id)?.pickTarget)
        .filter((target): target is THREE.Mesh => target !== undefined);

      const hit = this.raycaster.intersectObjects(targets, false)[0];
      const objectId = hit?.object.userData.objectId;
      state.setActiveObject(typeof objectId === 'string' ? objectId : null, additive);
      return;
    }

    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    const view = object ? this.views.get(object.id) : undefined;
    if (!object || !view) return;

    const result = pickElement(
      view,
      object.mesh,
      state.selectMode,
      pointer,
      this.camera,
      { width: this.canvas.clientWidth, height: this.canvas.clientHeight },
      this.raycaster,
    );

    if (!result) {
      if (!additive) {
        object.mesh.deselectAll();
        state.touchMesh();
      }
      return;
    }

    applySelection(object, state.selectMode, [result.elementId], {
      additive,
      loopSelect,
    });
    object.mesh.flushSelection(state.selectMode);
    state.touchMesh();
  }

  private boxSelect(rect: BoxSelectRect, additive: boolean): void {
    const state = useEditorStore.getState();
    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    const view = object ? this.views.get(object.id) : undefined;
    if (state.mode !== 'edit' || !object || !view) return;

    const hits = pickInRectangle(
      view,
      state.selectMode,
      rect,
      this.camera,
      { width: this.canvas.clientWidth, height: this.canvas.clientHeight },
      object.mesh,
    );

    if (!additive) object.mesh.deselectAll();
    applySelection(object, state.selectMode, hits, { additive: true, loopSelect: false });
    object.mesh.flushSelection(state.selectMode);
    state.touchMesh();
  }

  // -------------------------------------------------------------- framing

  private frame(target: 'selected' | 'all'): void {
    const state = useEditorStore.getState();
    const box = new THREE.Box3();

    for (const object of state.objects) {
      if (!object.visible) continue;
      if (target === 'selected' && !state.selectedObjectIds.includes(object.id)) continue;
      const view = this.views.get(object.id);
      if (!view) continue;
      box.expandByObject(view.group);
    }

    if (box.isEmpty()) return;
    this.controls.frameBox(box);
  }

  // ------------------------------------------------------------- lifecycle

  resize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;

    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();

    const halfHeight = (this.orthographicCamera.top - this.orthographicCamera.bottom) / 2;
    this.orthographicCamera.left = -halfHeight * aspect;
    this.orthographicCamera.right = halfHeight * aspect;
    this.orthographicCamera.updateProjectionMatrix();
  }

  private renderLoop = (): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.renderLoop);
    this.grid.update(this.controls.distance);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);

    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);

    for (const view of this.views.values()) view.dispose();
    this.views.clear();
    this.grid.dispose();
    this.disposeGizmo();
    this.renderer.dispose();
  }

  /**
   * Releases the gizmo without calling `TransformControls.dispose()`.
   *
   * In three r169 TransformControls extends Controls, which is an
   * EventDispatcher rather than an Object3D, but its dispose() still calls
   * this.traverse() and throws. Disconnecting the DOM listeners and releasing
   * the helper's GPU resources by hand does the same work safely.
   */
  private disposeGizmo(): void {
    this.gizmo.detach();

    const controls = this.gizmo as unknown as {
      disconnect?: () => void;
      dispose?: () => void;
    };
    if (typeof controls.disconnect === 'function') controls.disconnect();
    else controls.dispose?.();

    this.gizmoHelper.removeFromParent();
    this.gizmoHelper.traverse((child) => {
      const holder = child as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      holder.geometry?.dispose();
      if (holder.material) {
        if (Array.isArray(holder.material)) for (const item of holder.material) item.dispose();
        else holder.material.dispose();
      }
    });
  }
}

function applySelection(
  object: SceneObject,
  mode: SelectMode,
  ids: readonly number[],
  options: { additive: boolean; loopSelect: boolean },
): void {
  const mesh = object.mesh;
  if (!options.additive && !options.loopSelect) mesh.deselectAll();

  for (const id of ids) {
    if (mode === 'vertex') {
      const vert = mesh.verts.get(id);
      if (vert) vert.selected = options.additive ? !vert.selected : true;
    } else if (mode === 'edge') {
      const edge = mesh.edges.get(id);
      if (!edge) continue;
      if (options.loopSelect) {
        for (const member of selectEdgeLoop(mesh, edge)) member.selected = true;
      } else {
        edge.selected = options.additive ? !edge.selected : true;
      }
    } else {
      const face = mesh.faces.get(id);
      if (face) face.selected = options.additive ? !face.selected : true;
    }
  }
}

/**
 * TransformControls stopped being an Object3D in newer three releases and now
 * exposes its visual through `getHelper()`. Supporting both keeps the viewport
 * working across the version range in package.json.
 */
function resolveGizmoHelper(controls: TransformControls): THREE.Object3D {
  const candidate = controls as unknown as { getHelper?: () => THREE.Object3D };
  if (typeof candidate.getHelper === 'function') return candidate.getHelper();
  return controls as unknown as THREE.Object3D;
}

function focalLengthToFov(focalLength: number): number {
  // 35mm-equivalent sensor height, matching Blender's focal length readout.
  return 2 * THREE.MathUtils.radToDeg(Math.atan(12 / Math.max(focalLength, 1)));
}

function shallowArrayEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}
