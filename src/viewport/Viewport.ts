import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

import { ObjectView, VIEWPORT_COLORS } from '@bridge/index';
import {
  type PivotTool,
  type SelectMode,
  type Transform,
  type Vec3,
  centroid,
  medianPoint,
  mulVec,
  pivotPosition,
  selectEdgeLoop,
  translateVerts,
  vec3,
} from '@kernel/index';
import { evaluatedMesh, useEditorStore } from '@store/index';
import type { SceneObject } from '@store/types';

import { CameraController, MAX_ORBIT_DISTANCE } from './CameraController';
import { ViewportGrid } from './grid';
import { type BoxSelectRect, pickElement, pickInRectangle } from './picking';

/** Beyond this multiple of the max zoom, the scene reads as empty rather than distant. */
const VIEW_LOST_DISTANCE = MAX_ORBIT_DISTANCE * 0.45;

/** How long freshly created vertices stay flagged in the viewport. */
const RECENT_VERTS_MS = 1600;

interface GizmoBaseline {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

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
  private gizmoBaseline: GizmoBaseline | null = null;
  /** Ids of the selected, unlocked objects a group gizmo drag in object mode applies to. */
  private transformGroup: string[] = [];
  private readonly objectBaselines = new Map<string, Transform>();
  private gizmoDragging = false;
  private viewLostReported = false;
  private recentVerts: { objectId: string; ids: Set<number>; expiresAt: number } | null = null;

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
    this.canvas.addEventListener('lostpointercapture', this.handleLostPointerCapture);

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
      // An operator reporting new vertices flags them for a moment. The expiry
      // is checked in the render loop rather than by a timer, so the flash
      // cannot outlive the viewport or fire after it is disposed.
      store.subscribe(
        (state) => state.recentVerts,
        (recent) => {
          this.recentVerts = recent
            ? {
                objectId: recent.objectId,
                ids: new Set(recent.vertIds),
                expiresAt: performance.now() + RECENT_VERTS_MS,
              }
            : null;
          this.syncScene();
        },
      ),
      // Locking is neither a geometry nor a selection change, so none of the
      // subscriptions above would re-run — yet a locked object has to lose its
      // gizmo, since dragging it is refused anyway.
      store.subscribe(
        (state) => state.objects.map((object) => object.locked),
        () => this.updateGizmo(),
        { equalityFn: shallowArrayEqual },
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
        selectMode: state.selectMode,
        recentVerts: this.recentVerts?.objectId === object.id ? this.recentVerts.ids : undefined,
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

  /** Drops the just-created-vertex flash once its moment has passed. */
  private expireRecentVerts(): void {
    if (!this.recentVerts || performance.now() < this.recentVerts.expiresAt) return;
    this.recentVerts = null;
    useEditorStore.getState().clearRecentVerts();
    this.syncScene();
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

  /**
   * Re-seats the gizmo on the current selection.
   *
   * Never mid-drag: from pointer-down to pointer-up the proxy belongs to
   * TransformControls, which drives it as `transform-at-drag-start + total
   * pointer offset`. `syncScene()` calls this on every store change — including
   * the ones a drag itself emits — so re-seating the proxy here would reset the
   * baseline each tick and turn every absolute drag delta into a corrupted
   * incremental one, leaving the dragged objects stuttering between two
   * positions instead of following the pointer.
   */
  private updateGizmo(): void {
    if (this.gizmoDragging) return;

    const state = useEditorStore.getState();
    const modeMap = { move: 'translate', rotate: 'rotate', scale: 'scale' } as const;
    const gizmoMode = modeMap[state.activeTool as keyof typeof modeMap];

    if (!gizmoMode) {
      this.detachGizmo();
      return;
    }

    if (state.mode === 'object') {
      this.updateObjectGizmo(state, gizmoMode);
      return;
    }

    this.updateEditGizmo(state, gizmoMode);
  }

  private detachGizmo(): void {
    this.gizmo.detach();
    this.gizmo.enabled = false;
    this.gizmoHelper.visible = false;
    this.transformGroup = [];
  }

  /**
   * Positions the gizmo for object mode.
   *
   * With one object selected it sits at that object's own transform, oriented
   * to it, exactly as before. With several selected it sits at their median
   * position with a neutral (world-aligned) orientation, and the resulting
   * drag is applied to every one of them — Blender's median-point, global
   * pivot default for multi-object transforms.
   */
  private updateObjectGizmo(state: ReturnType<typeof useEditorStore.getState>, gizmoMode: 'translate' | 'rotate' | 'scale'): void {
    const selected = state.objects.filter((object) => state.selectedObjectIds.includes(object.id));
    const transformable = selected.filter((object) => !object.locked);

    if (transformable.length === 0) {
      this.detachGizmo();
      return;
    }

    this.gizmo.setMode(gizmoMode);
    this.gizmo.enabled = true;
    this.gizmoHelper.visible = true;
    this.transformGroup = transformable.map((object) => object.id);

    if (transformable.length === 1) {
      const { position, rotation, scale } = transformable[0].transform;
      this.gizmoProxy.position.set(position.x, position.y, position.z);
      this.gizmoProxy.rotation.set(rotation.x, rotation.y, rotation.z);
      this.gizmoProxy.scale.set(scale.x, scale.y, scale.z);
    } else {
      const pivot = centroid(transformable.map((object) => object.transform.position));
      this.gizmoProxy.position.set(pivot.x, pivot.y, pivot.z);
      this.gizmoProxy.rotation.set(0, 0, 0);
      this.gizmoProxy.scale.set(1, 1, 1);
    }

    this.captureGizmoBaseline();
    this.gizmo.attach(this.gizmoProxy);
  }

  /** In edit mode the gizmo drives the selection's median point on the one active object. */
  private updateEditGizmo(state: ReturnType<typeof useEditorStore.getState>, gizmoMode: 'translate' | 'rotate' | 'scale'): void {
    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    if (!object || object.locked) {
      this.detachGizmo();
      return;
    }

    const selected = object.mesh.selectedVerts();
    if (selected.length === 0) {
      this.detachGizmo();
      return;
    }

    this.gizmo.setMode(gizmoMode);
    this.gizmo.enabled = true;
    this.gizmoHelper.visible = true;
    this.transformGroup = [];

    const median = medianPoint(selected);
    const local = new THREE.Vector3(median.x, median.y, median.z).applyMatrix4(
      this.views.get(object.id)?.group.matrix ?? new THREE.Matrix4(),
    );
    this.gizmoProxy.position.copy(local);
    this.gizmoProxy.rotation.set(0, 0, 0);
    this.gizmoProxy.scale.set(1, 1, 1);

    this.captureGizmoBaseline();
    this.gizmo.attach(this.gizmoProxy);
  }

  private captureGizmoBaseline(): void {
    this.gizmoBaseline = {
      position: this.gizmoProxy.position.clone(),
      quaternion: this.gizmoProxy.quaternion.clone(),
      scale: this.gizmoProxy.scale.clone(),
    };
  }

  private handleGizmoDragging = (event: { value: unknown }): void => {
    const dragging = event.value === true;
    this.gizmoDragging = dragging;
    const state = useEditorStore.getState();

    if (dragging) {
      this.captureGizmoBaseline();
      this.objectBaselines.clear();
      for (const object of state.objects) {
        if (!this.transformGroup.includes(object.id)) continue;
        this.objectBaselines.set(object.id, structuredClone(object.transform));
      }
      state.recordHistory(state.mode === 'object' ? 'Transform object' : 'Move selection');
      return;
    }

    // `gizmoDragging` is already false, so this resync is the one that re-seats
    // the gizmo on where the selection actually landed.
    state.touchMesh();
  };

  private handleGizmoChange = (): void => {
    const state = useEditorStore.getState();
    if (!this.gizmoBaseline) return;

    if (state.mode === 'object') {
      this.applyObjectGroupTransform(state);
      return;
    }

    const object = state.objects.find((candidate) => candidate.id === state.activeObjectId);
    if (!object) return;

    const delta = this.gizmoProxy.position.clone().sub(this.gizmoBaseline.position);
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
    this.captureGizmoBaseline();
    state.touchMesh();
  };

  /**
   * Applies a group gizmo drag to every object in `transformGroup`.
   *
   * The delta between the gizmo's current transform and its transform at drag
   * start (not the previous tick) is what gets applied, computed against each
   * object's own transform at drag start. That avoids compounding rounding
   * error across many pointer-move ticks in a single drag, and is what makes a
   * single object behave exactly as it did before this pivot moved to the
   * group's median: for one object the pivot IS that object's own position, so
   * the rotate/scale math below reduces to the previous direct-assignment
   * behaviour.
   */
  private applyObjectGroupTransform(state: ReturnType<typeof useEditorStore.getState>): void {
    if (!this.gizmoBaseline || this.transformGroup.length === 0) return;

    const pivotProxy = this.gizmoBaseline.position;
    const pivot = vec3(pivotProxy.x, pivotProxy.y, pivotProxy.z);
    const tool = state.activeTool as PivotTool;

    const deltaPosition = this.gizmoProxy.position.clone().sub(pivotProxy);
    const translation = vec3(deltaPosition.x, deltaPosition.y, deltaPosition.z);

    const deltaQuaternion = this.gizmoProxy.quaternion
      .clone()
      .multiply(this.gizmoBaseline.quaternion.clone().invert());
    const { axis: rotationAxis, angle: rotationAngle } = quaternionToAxisAngle(deltaQuaternion);

    const scaleRatio = vec3(
      this.gizmoProxy.scale.x / (this.gizmoBaseline.scale.x || 1),
      this.gizmoProxy.scale.y / (this.gizmoBaseline.scale.y || 1),
      this.gizmoProxy.scale.z / (this.gizmoBaseline.scale.z || 1),
    );

    const patches = this.transformGroup.reduce<
      { id: string; transform: Partial<SceneObject['transform']> }[]
    >((accumulator, id) => {
      const baseline = this.objectBaselines.get(id);
      if (!baseline) return accumulator;

      // The pivot arithmetic (offset from pivot, rotate/scale, add pivot back)
      // is pure kernel math, unit tested in kernel/ops/pivotTransform.test.ts.
      const position = pivotPosition(baseline.position, pivot, tool, {
        translation,
        rotationAxis,
        rotationAngle,
        scaleRatio,
      });

      let rotation = baseline.rotation;
      let scale = baseline.scale;

      if (tool === 'rotate') {
        // The object's own orientation still needs a quaternion round-trip
        // (Euler decomposition is fragile to hand-roll but THREE's is solid),
        // so that part stays here rather than in the pure kernel function.
        const baselineQuaternion = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(baseline.rotation.x, baseline.rotation.y, baseline.rotation.z, 'XYZ'),
        );
        const newQuaternion = deltaQuaternion.clone().multiply(baselineQuaternion);
        const newEuler = new THREE.Euler().setFromQuaternion(newQuaternion, 'XYZ');
        rotation = vec3(newEuler.x, newEuler.y, newEuler.z);
      } else if (tool === 'scale') {
        scale = mulVec(baseline.scale, scaleRatio);
      }

      accumulator.push({ id, transform: { position, rotation, scale } });
      return accumulator;
    }, []);

    state.setObjectTransforms(patches);
  }

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

  /**
   * Ends a gizmo drag whose pointer went away without a pointerup.
   *
   * TransformControls clears `dragging` only in its pointerup handler, so a
   * capture dropped some other way — the pointer leaving the window, a release
   * the page never sees, a cancelled touch — leaves the gizmo latched: the
   * selection keeps following the bare cursor and viewport clicks are swallowed
   * because they look like part of the drag. Clearing the flags goes through
   * three's own `dragging-changed`, so the drag finishes on the normal path.
   * On an ordinary pointerup this has already run and is a no-op.
   */
  private handleLostPointerCapture = (): void => {
    if (!this.gizmoDragging) return;
    this.gizmo.axis = null;
    this.gizmo.dragging = false;
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

    const distance = this.controls.distance;
    this.grid.update(distance);
    this.extendFarPlane(distance);
    this.updateViewLost(distance);
    this.expireRecentVerts();
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Keeps the far clipping plane ahead of the current zoom.
   *
   * The far plane used to be a fixed 2000 units (from `clipEnd`'s default),
   * while the orbit can zoom out to `MAX_ORBIT_DISTANCE` (5000). Once the
   * camera-to-target distance passed the fixed far plane, the target — and
   * everything near it, grid included — fell outside the frustum and the
   * whole viewport went blank well short of the actual zoom limit. Tracking
   * the far plane against distance (with room to spare) means the grid keeps
   * rendering for the entire zoom range instead of vanishing partway through.
   * `clipEnd` still acts as a floor for users who raise it directly.
   */
  private extendFarPlane(distance: number): void {
    const required = distance * 2 + 200;
    const far = Math.max(useEditorStore.getState().clipEnd, required);

    if (Math.abs(this.perspectiveCamera.far - far) > 1) {
      this.perspectiveCamera.far = far;
      this.perspectiveCamera.updateProjectionMatrix();
    }
    if (Math.abs(this.orthographicCamera.far - far) > 1) {
      this.orthographicCamera.far = far;
      this.orthographicCamera.updateProjectionMatrix();
    }
  }

  /** Flags when the orbit has scrolled far enough out that Frame All should draw attention. */
  private updateViewLost(distance: number): void {
    const lost = useEditorStore.getState().objects.length > 0 && distance > VIEW_LOST_DISTANCE;
    if (lost === this.viewLostReported) return;
    this.viewLostReported = lost;
    useEditorStore.getState().setViewLost(lost);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);

    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
    this.canvas.removeEventListener('lostpointercapture', this.handleLostPointerCapture);

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
      if (!vert) continue;
      if (options.additive && vert.selected) {
        vert.selected = false;
      } else {
        mesh.selectVert(vert);
      }
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

/**
 * Standard quaternion → axis-angle conversion.
 *
 * Kept as a plain formula rather than reached for via a THREE helper: THREE's
 * `Quaternion` has no built-in "get axis and angle" accessor, only conversions
 * to/from Euler and rotation matrices. This is the few-line textbook version
 * (angle from `w`, axis from the normalised imaginary part), which the kernel's
 * `rotationMatrix(axis, angle)` then turns back into a rotation.
 */
function quaternionToAxisAngle(q: THREE.Quaternion): { axis: Vec3; angle: number } {
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
  const s = Math.sqrt(1 - q.w * q.w);
  if (s < 1e-6) return { axis: vec3(0, 1, 0), angle: 0 };
  return { axis: vec3(q.x / s, q.y / s, q.z / s), angle };
}
