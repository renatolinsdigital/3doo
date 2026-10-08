import type { StateCreator } from 'zustand';

import {
  type BMesh,
  type BooleanOp,
  type ImportedObject,
  type LatticeCage,
  type LatticeModifier,
  type LatticeResolution,
  type Modifier,
  type ModifierContext,
  type OperatorResult,
  type PrimitiveKind,
  type PrimitiveParams,
  type ProjectAssetData,
  type ProjectDocument,
  type SceneObjectSnapshot,
  type Vec3,
  type Vert,
  DEFAULT_LATTICE_RESOLUTION,
  DEFAULT_PRIMITIVE_PARAMS,
  History,
  METRE_PARAMS,
  MIN_OBJECT_SIZE,
  PRIMITIVE_DEFAULT_OVERRIDES,
  PRIMITIVE_LABELS,
  add,
  applyModifier,
  booleanMeshStaged,
  centroid,
  clampLatticeResolution,
  clampObjectScale,
  cloneMesh,
  composeMatrix,
  createLatticeMesh,
  createModifier,
  createImagePlane,
  createPrimitive,
  createTransform,
  deserializeProject,
  equals,
  evaluateModifiers,
  execOperator,
  flipNormals,
  imagePlaneSize,
  splitLooseParts,
  inverseMatrix,
  inverseTransformOffset,
  inverseTransformPoint,
  latticePoints,
  latticeRestPoints,
  latticeShape,
  lerp,
  medianPoint,
  mulVec,
  multiplyMatrices,
  normalizePrimitiveParams,
  resampleLattice,
  serializeProject,
  sub,
  transformPoint,
  translateVerts,
  vec3,
} from '@kernel/index';

import { WorkerUnavailable, booleanOffThread, canRunOffThread } from '../booleanOffThread';
import type { EditorStore } from '../useEditorStore';
import type {
  CursorSnapKind,
  CursorSnapTargets,
  LastOperator,
  Material,
  MoveTarget,
  SceneAsset,
  SceneGroup,
  SceneObject,
  SelectIntent,
} from '../types';
import { DEFAULT_PREFERENCES } from './preferences';

/**
 * What each pointer snap says when it lands and when it finds nothing.
 *
 * The right-click menu and the keyboard run the same snaps for the same
 * reasons, so they report them in the same words: written once here rather
 * than once per caller, which is how the menu's shortcut labels drifted.
 */
export const CURSOR_SNAPS: Record<CursorSnapKind, { label: string; missing: string }> = {
  point: {
    label: 'Cursor placed',
    missing: 'Nothing under the pointer to place the cursor on',
  },
  vertex: { label: 'Cursor to vertex', missing: 'No vertex close enough to the pointer' },
  edge: { label: 'Cursor to edge centre', missing: 'No edge close enough to the pointer' },
  face: { label: 'Cursor to face centre', missing: 'No face under the pointer' },
};

const BOOLEAN_LABELS: Record<BooleanOp, string> = {
  union: 'Union',
  difference: 'Difference',
  intersect: 'Intersect',
};

/**
 * Undo lives outside React state: the store mirrors its flags and its labels,
 * and the documents themselves never reach a render.
 *
 * Built at the size a fresh install uses. A stored preference is handed over
 * once the store exists, in `useEditorStore`.
 */
const history = new History(DEFAULT_PREFERENCES.historySize);

/**
 * How many `transact` calls are running. While any is, the actions inside it
 * record no steps and drop none: the transaction keeps the one step that
 * stands for all of them.
 */
let historyHold = 0;

/** The mirror the undo buttons and the history dialog render from. */
function historyState() {
  return {
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    historyUndo: history.undoLabels,
    historyRedo: history.redoLabels,
  };
}

let objectCounter = 0;
let groupCounter = 0;
let materialCounter = 0;
let lockAttemptCounter = 0;
let recentVertsCounter = 0;

/**
 * The objects the size floor is currently holding, keyed by the dial that ran
 * into it, so each is reported once.
 *
 * A drag hands the store a scale on every pointer tick, so an object pinned at
 * the floor would otherwise announce itself sixty times a second. A key goes in
 * when the floor first catches the object and comes out when a value gets
 * through untouched, which is the only way back to a size worth warning about
 * again. The two dials are counted apart because reaching the floor on one says
 * nothing about the other: an object already scaled as small as it goes can
 * still have its radius typed down past the limit.
 */
const heldAtSizeFloor = new Set<string>();

/**
 * Which page load made an id, so the ids it makes cannot meet those in a file.
 *
 * The counters start again at every load, while a scene opened from a `.3doo`
 * keeps the ids it was saved with. On a counter alone, the next object added
 * could take the id of one already on screen, and the viewport, which draws
 * one mesh per id, drew the new object in the old one's place.
 */
const SESSION = Date.now().toString(36);

function nextObjectId(): string {
  objectCounter += 1;
  return `object-${SESSION}-${objectCounter}`;
}

function nextGroupId(): string {
  groupCounter += 1;
  return `group-${SESSION}-${groupCounter}`;
}

/** The first GROUP name no folder is wearing yet. */
function groupName(groups: readonly SceneGroup[]): string {
  const taken = new Set(groups.map((group) => group.name));
  if (!taken.has('GROUP')) return 'GROUP';

  let index = 2;
  while (taken.has(`GROUP.${index}`)) index += 1;
  return `GROUP.${index}`;
}

/**
 * Drops the folders nothing points at any more.
 *
 * A group is its objects: there is no way to put something into an empty one,
 * so one left behind by a delete or a regroup would sit there for good.
 */
function pruneGroups(groups: readonly SceneGroup[], objects: readonly SceneObject[]): SceneGroup[] {
  const used = new Set(objects.map((object) => object.groupId));
  return groups.filter((group) => used.has(group.id));
}

/** The objects a folder holds, in the order the scene lists them. */
function groupMembers(objects: readonly SceneObject[], groupId: string): SceneObject[] {
  return objects.filter((object) => object.groupId === groupId);
}

/**
 * The assets as a document lists them: everything but the bytes.
 *
 * The bytes are held once, in the store and in the file being written, and a
 * history step that carried them would be a copy of every picture in the scene
 * per entry.
 */
function assetMetadata(assets: Record<string, SceneAsset>): ProjectAssetData[] {
  return Object.values(assets).map(({ id, name, type, width, height }) => ({
    id,
    name,
    type,
    width,
    height,
  }));
}

/**
 * The loaded assets, plus an entry for anything the document names that the
 * session has never heard of.
 *
 * The new entries have no bytes, so the object draws blank and the panel can
 * say which file is missing. Silently dropping them would leave an object
 * pointing at nothing with no way to say so.
 */
function mergedAssets(
  loaded: Record<string, SceneAsset>,
  described: readonly ProjectAssetData[],
): Record<string, SceneAsset> {
  const merged = { ...loaded };
  for (const asset of described) {
    merged[asset.id] ??= { ...asset, blob: null };
  }
  return merged;
}

const DEFAULT_MATERIAL_COLOR = { r: 0.85, g: 0.84, b: 0.8 };

function defaultMaterial(): Material {
  materialCounter += 1;
  return {
    id: `material-${SESSION}-${materialCounter}`,
    name: `Material ${materialCounter}`,
    color: { ...DEFAULT_MATERIAL_COLOR },
  };
}

/** Whether a material still wears the colour it was created with. */
function isUncoloured(material: Material): boolean {
  const { r, g, b } = material.color;
  return (
    r === DEFAULT_MATERIAL_COLOR.r &&
    g === DEFAULT_MATERIAL_COLOR.g &&
    b === DEFAULT_MATERIAL_COLOR.b
  );
}

/**
 * How far an object's origin sits from the middle of its own mesh.
 *
 * The bounding box centre rather than the average of the vertices: a densely
 * tessellated end would drag an average towards itself, and the origin is
 * wanted where the shape looks centred.
 */
function originOffset(object: SceneObject): Vec3 {
  const box = object.mesh.boundingBox();
  return centroid([box.min, box.max]);
}

/**
 * `object`'s transform with `patch` folded in, and any new scale held to the
 * floor that keeps the object big enough to draw.
 *
 * Every scale an object can be given arrives through here, whether it was
 * dragged on the gizmo, typed into the properties panel or accumulated by the
 * modal S tool, so this is the one place the floor has to hold.
 *
 * `held` says the floor actually caught something: the scale asked for was
 * smaller than the one handed back. Nothing else can tell the difference
 * between an object that stopped shrinking and a drag that has simply run out
 * of room, which is the difference the warning is there to close.
 */
function withScaleFloor(
  object: SceneObject,
  patch: Partial<SceneObject['transform']>,
): { transform: SceneObject['transform']; held: boolean } {
  const transform = { ...object.transform, ...patch };
  if (!patch.scale) return { transform, held: false };

  const scale = clampObjectScale(object.mesh, transform.scale);
  const asked = transform.scale;
  const held = scale.x !== asked.x || scale.y !== asked.y || scale.z !== asked.z;
  return { transform: { ...transform, scale }, held };
}

/**
 * Notes which objects the floor is holding and writes the warning for the ones
 * that have not said so yet, or null when they all have.
 *
 * The whole batch is one message rather than one each: scaling a selection to
 * nothing would otherwise stack a toast per object.
 */
function sizeFloorWarning(
  dial: 'scale' | 'length',
  entries: readonly { object: SceneObject; held: boolean }[],
): string | null {
  const fresh: SceneObject[] = [];

  for (const { object, held } of entries) {
    const key = `${dial}:${object.id}`;
    if (!held) heldAtSizeFloor.delete(key);
    else if (!heldAtSizeFloor.has(key)) {
      heldAtSizeFloor.add(key);
      fresh.push(object);
    }
  }

  if (fresh.length === 0) return null;

  const floor = `${MIN_OBJECT_SIZE * 1000} mm`;
  const limit = dial === 'scale' ? `scale below ${floor} across` : `be built finer than ${floor}`;
  return fresh.length === 1
    ? `${fresh[0].name} has reached the size limit: it will not ${limit}.`
    : `${fresh.length} objects have reached the size limit: they will not ${limit}.`;
}

/**
 * Puts one object's origin on a world point, leaving the mesh where it stands.
 *
 * The vertices give up exactly what the origin gains, so nothing moves on
 * screen: the point read in the object's own frame is the shift every vertex
 * owes. It writes into the mesh, so the caller has to own that mesh: one with
 * other users would carry every one of them off its own origin.
 */
function moveOrigin(object: SceneObject, position: Vec3): SceneObject {
  const local = inverseTransformPoint(object.transform, position);
  for (const vert of object.mesh.verts.values()) vert.co = sub(vert.co, local);

  return {
    ...object,
    transform: { ...object.transform, position: { ...position } },
    // The primitive parameters describe a mesh built around the old origin;
    // editing one now would regenerate it back over the move.
    primitive: null,
  };
}

/**
 * The scene with `sources` folded into `target`: one object where there were
 * several, and everything else left where it was.
 *
 * Geometry travels through world space rather than being copied raw: every
 * source sits somewhere of its own, and dropping its vertices straight into
 * the target's local space would pile them all onto the target's origin.
 * Modifiers on the sources are dropped with them; the target keeps its own.
 */
function foldInto(
  objects: readonly SceneObject[],
  target: SceneObject,
  sources: readonly SceneObject[],
): SceneObject[] {
  const absorbed = new Set(sources.map((object) => object.id));

  // Merging into a mesh that an object outside the merge also uses would
  // reshape that object too, so the target takes a copy of its own first.
  const shared = objects.some(
    (object) => object.mesh === target.mesh && object.id !== target.id && !absorbed.has(object.id),
  );
  const merged = shared ? cloneMesh(target.mesh) : target.mesh;
  const materials = [...target.materials];

  for (const source of sources) {
    // Read the source out before anything is added: merging a linked
    // duplicate into its own original walks the very mesh being written to.
    const verts = [...source.mesh.verts.values()];
    const rings = [...source.mesh.faces.values()].map((face) => ({
      vertIds: source.mesh.faceVerts(face).map((vert) => vert.id),
      materialIndex: face.materialIndex,
      smooth: face.smooth,
    }));

    const slots = mergeMaterialSlots(materials, source.materials);

    const matrix = composeMatrix(source.transform);
    const map = new Map<number, Vert>();
    for (const vert of verts) {
      const world = transformPoint(matrix, vert.co);
      map.set(vert.id, merged.addVert(inverseTransformPoint(target.transform, world)));
    }

    for (const ring of rings) {
      const face = ring.vertIds.map((id) => map.get(id));
      if (face.every((vert): vert is Vert => vert !== undefined)) {
        merged.addFace(face, {
          materialIndex: slots[ring.materialIndex] ?? 0,
          smooth: ring.smooth,
        });
      }
    }
  }

  merged.computeNormals();

  return objects
    .filter((object) => !absorbed.has(object.id))
    .map((object) =>
      object.id === target.id
        ? // The parameters described the target's own shape, not the merge. The
          // result spans everything that came in, so the target's old origin can
          // now sit anywhere in it, or outside it altogether.
          recenterOrigin({ ...object, mesh: merged, materials, primitive: null })
        : object,
    );
}

/** Puts one object's origin back on the middle of its own mesh. */
function recenterOrigin(object: SceneObject): SceneObject {
  const offset = originOffset(object);
  if (equals(offset, vec3())) return object;

  return moveOrigin(object, transformPoint(composeMatrix(object.transform), offset));
}

/**
 * Adds the slots of `incoming` that `materials` does not hold yet, and says
 * where each incoming slot ended up.
 *
 * Matched by identity, so bringing in a duplicate or a cutter wearing the
 * target's own material does not leave two slots pointing at one material.
 *
 * With `uncoloured` given, a material nobody has coloured goes there instead
 * of into a slot of its own. A boolean passes it: every primitive is added
 * wearing a fresh default, so each cut used to leave one more grey slot
 * behind, and the walls it opened came out grey in a target that was not.
 */
function mergeMaterialSlots(
  materials: Material[],
  incoming: readonly Material[],
  uncoloured?: number,
): number[] {
  return incoming.map((material) => {
    const existing = materials.findIndex((candidate) => candidate.id === material.id);
    if (existing !== -1) return existing;
    if (uncoloured !== undefined && isUncoloured(material)) return uncoloured;
    materials.push(structuredClone(material));
    return materials.length - 1;
  });
}

/** What an edit that writes into vertices says when every target shares its mesh. */
const LINKED_MESH_REFUSAL = 'Linked meshes have to be made single-user first';

/**
 * The objects among `targets` that are the only user of their mesh.
 *
 * A linked duplicate shares its mesh instance, so an edit written into one
 * object's vertices would carry every other user of that mesh along with it.
 */
export function soleMeshUsers(
  objects: readonly SceneObject[],
  targets: readonly SceneObject[],
): SceneObject[] {
  return targets.filter(
    (object) => objects.filter((other) => other.mesh === object.mesh).length === 1,
  );
}

/** What edit mode says when asked to do anything to a cage but move its points. */
export const CAGE_REFUSAL = 'A cage keeps its grid: move, turn or scale its points instead';

/** What baking or moving an origin says when every target is a cage. */
const CAGE_TRANSFORM_REFUSAL = 'A cage keeps its own origin and scale: they place its grid';

/**
 * The operators a cage's points may go through: the ones that move vertices or
 * pick them, and nothing that adds, removes or joins one. A cage is read by the
 * order its vertices were made in, so how many there are has to hold.
 */
const CAGE_OPERATORS: ReadonlySet<string> = new Set([
  'translate',
  'rotate',
  'scale',
  'shrinkFatten',
  'relax',
  'circle',
  'space',
  'vertexSlide',
  'edgeSlide',
  'setEdgeLength',
  'selectAll',
  'deselectAll',
  'invertSelection',
  'selectEdgeLoop',
  'growSelection',
  'shrinkSelection',
]);

/** How far a new cage stands off the mesh, as a share of the mesh's longest side. */
const CAGE_MARGIN = 0.1;

/**
 * A new cage around what `object` draws with the modifiers in `below`.
 *
 * Turned and placed with the object and stretched over its bounding box, with
 * a margin so the cage reads apart from the mesh rather than lying along its
 * outermost edges. A side with no depth, a plane's, still gets some: a cage
 * needs room to measure across.
 */
function cageAround(
  object: SceneObject,
  below: readonly Modifier[],
  context: ModifierContext,
): SceneObject {
  const box = evaluateModifiers(object.mesh, below, context).boundingBox();
  const size = sub(box.max, box.min);
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const side = (length: number) => Math.max(length, longest * CAGE_MARGIN) + longest * CAGE_MARGIN;
  const resolution = { ...DEFAULT_LATTICE_RESOLUTION };

  return {
    id: nextObjectId(),
    name: `${object.name}.CAGE`,
    mesh: createLatticeMesh(resolution),
    transform: {
      position: transformPoint(composeMatrix(object.transform), lerp(box.min, box.max, 0.5)),
      rotation: { ...object.transform.rotation },
      scale: mulVec(object.transform.scale, vec3(side(size.x), side(size.y), side(size.z))),
    },
    visible: true,
    locked: false,
    parentId: null,
    groupId: object.groupId,
    materials: [defaultMaterial()],
    modifiers: [],
    activeMaterial: 0,
    primitive: null,
    image: null,
    lattice: { resolution },
  };
}

/**
 * The scene with a new cage fitted around `object`, next to it in the
 * outliner, and `modifier` pointed at it. A modifier not yet on the stack goes
 * on the end of it.
 */
function withNewCage(
  state: EditorStore,
  object: SceneObject,
  modifier: LatticeModifier,
): Partial<EditorStore> {
  const index = object.modifiers.findIndex((candidate) => candidate.id === modifier.id);
  const below = index < 0 ? object.modifiers : object.modifiers.slice(0, index);
  const cage = cageAround(object, below, modifierContext(object, state.cursor, state.objects));
  const linked: LatticeModifier = { ...modifier, objectId: cage.id };
  const modifiers =
    index < 0
      ? [...object.modifiers, linked]
      : object.modifiers.map((candidate) => (candidate.id === modifier.id ? linked : candidate));

  return {
    objects: state.objects.flatMap((candidate) =>
      candidate.id === object.id ? [{ ...candidate, modifiers }, cage] : [candidate],
    ),
    meshVersion: state.meshVersion + 1,
    status: `Added ${cage.name}: select it and press Tab to move its points`,
  };
}

/**
 * The scene with a cage's mesh swapped for `mesh`, on every object sharing it,
 * since a linked copy of a cage is the same grid.
 */
function withCageMesh(
  state: EditorStore,
  cage: SceneObject,
  mesh: BMesh,
  lattice: NonNullable<SceneObject['lattice']>,
  status: string,
): Partial<EditorStore> {
  return {
    objects: state.objects.map((object) =>
      object.mesh === cage.mesh ? { ...object, mesh, lattice } : object,
    ),
    meshVersion: state.meshVersion + 1,
    status,
  };
}

export interface SceneSlice {
  objects: SceneObject[];
  /** The outliner's folders, in the order they are drawn. */
  groups: SceneGroup[];
  /**
   * Imported binaries, by id: the images objects are drawn with.
   *
   * Beside the objects rather than inside them because undo replays the object
   * list and nothing else. An image deleted and undone finds its bytes still
   * here, and a history step stays the size of a scene description rather than
   * carrying a copy of every picture in it.
   */
  assets: Record<string, SceneAsset>;
  activeObjectId: string | null;
  selectedObjectIds: string[];
  cursor: Vec3;
  projectName: string;
  /** Bumped on every geometry change so the viewport and panels can react. */
  meshVersion: number;
  /**
   * Whether the project has been changed since it was last stored.
   *
   * Set by a subscription in `useEditorStore` rather than by each action that
   * edits something: a rename, a regroup and a vertex slide all change the
   * document and only one of them touches geometry, so a flag raised by hand
   * would have to be raised in thirty places and would be missed in the
   * thirty-first.
   *
   * False on a scene nobody has touched yet: the cube a fresh tab opens on is
   * the editor's doing rather than the user's, and a file just opened is
   * already exactly what is stored.
   */
  dirty: boolean;
  /**
   * `sceneFingerprint` of the scene as last stored, by SAVE or by the
   * autosave, or null while nothing stored is known to hold it.
   *
   * `dirty` only says the scene was touched since, and the autosave checks
   * this before writing so it never stores again what is already stored. A
   * separate field because the flag goes up on every edit, while this costs a
   * pass over the whole scene, which is worth paying once a tick at most.
   */
  savedFingerprint: number | null;
  /**
   * Whether this exact scene is sitting in a `.3doo` on disk.
   *
   * Lowered by the same subscription that raises `dirty`, so the first edit
   * after a save takes it away. Separate from `dirty` because the autosave
   * lowers that one with a numbered copy, which is a backup rather than the
   * project's own file. FILE > NEW and FILE > OPEN discard the scene on screen,
   * and this is what says whether that costs the user anything.
   */
  savedToFile: boolean;
  /**
   * The `.3doo` this project was opened from or last saved to, which FILE >
   * SAVE writes over without asking where.
   *
   * An edit leaves it in place, unlike `savedToFile`: the project still
   * belongs to that file once it has moved on from what the file holds. Null
   * until there is a file the page may write back to, which a download or a
   * file input never gives it.
   */
  projectFile: FileSystemFileHandle | null;
  /**
   * The folder the user chose for the numbered copies, which go in a
   * `3doo-auto-saves` inside it, or null until one is chosen.
   *
   * Left alone by `resetScene`, like `autosaveToken`: it is where the autosave
   * writes rather than part of any one project, so FILE > NEW changes what
   * goes into it, not where. Turning autosave off keeps it too.
   */
  autosaveLocation: FileSystemDirectoryHandle | null;
  /**
   * Whether the page may write to that location right now.
   *
   * False after a browser restart until the user allows it again, which takes
   * a click. Nothing is auto-saved meanwhile.
   */
  autosaveLocationReady: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** What each undo would take back, newest first, for the history dialog. */
  historyUndo: string[];
  /** What each redo would put back, the next one first. */
  historyRedo: string[];
  status: string;
  /** The operator that last changed a mesh, run through `exec` or by a gesture. */
  lastOperator: LastOperator | null;
  /**
   * Set whenever an edit is denied because its object is locked. The token
   * bumps on every denial (even repeats on the same object) so a UI can react
   * to the one denial event, rather than to the locked state itself.
   */
  lockedAttempt: { objectId: string; token: number } | null;
  /**
   * Vertices an operator just created, for the viewport to flash briefly. The
   * token bumps on every run so repeating one re-triggers the flash.
   */
  recentVerts: { objectId: string; vertIds: number[]; token: number } | null;
  /**
   * Bumped every time the autosave finishes a write, for the status bar to
   * flash its disk.
   *
   * A counter rather than the time of the write: two ticks a minute apart
   * both have to start the animation over, and a timestamp the reader would
   * have to compare against the clock says nothing more. Not `dirty` either,
   * which is lowered before the write goes out and stays lowered while it is
   * in flight, so it reads the same whether the write landed or failed.
   *
   * Left alone by `resetScene`, unlike everything around it. The reader
   * flashes on the number changing, so putting it back to zero would draw a
   * disk for FILE > NEW, which writes nothing.
   */
  autosaveToken: number;

  addPrimitive: (kind: PrimitiveKind, params?: Partial<PrimitiveParams>) => void;
  /**
   * Adds an imported image as a plane at the world origin.
   *
   * The origin rather than the 3D cursor, unlike every other add: a reference
   * image is lined up against the world, and starting it wherever the cursor
   * was left is a nuisance rather than a convenience.
   */
  addImage: (asset: SceneAsset) => void;
  /**
   * Adds what a mesh file held, as one step to undo, named after the file.
   *
   * At the 3D cursor like a primitive, each object keeping its place relative
   * to the others, and all of them selected so they move as one.
   */
  addImportedObjects: (imported: readonly ImportedObject[], source: string) => void;
  updatePrimitiveParams: (params: Partial<PrimitiveParams>) => void;
  patchActiveObject: (
    patch: Partial<SceneObject> | ((object: SceneObject) => Partial<SceneObject> | null),
    options?: { touchGeometry?: boolean; status?: string },
  ) => void;
  setActiveObject: (id: string | null, intent?: SelectIntent) => void;
  deselectObject: (id: string) => void;
  selectObjects: (ids: readonly string[], intent?: SelectIntent) => void;
  clearSelection: () => void;
  selectAllObjects: () => void;
  renameObject: (id: string, name: string) => void;
  toggleObjectVisibility: (id: string) => void;
  toggleObjectLock: (id: string) => void;
  noteLockedAttempt: (objectId: string) => void;
  clearRecentVerts: () => void;
  duplicateSelected: (linked?: boolean) => void;
  mergeSelected: () => void;

  /**
   * Puts the selected objects in a folder of their own.
   *
   * Objects already in another folder move across, which is the only way to
   * regroup them: a folder holds each object once, and nothing can be in two.
   */
  groupSelected: () => void;
  renameGroup: (id: string, name: string) => void;
  /** Selects everything in the folder, dropping whatever else was selected. */
  selectGroup: (id: string) => void;
  /** Deletes the folder and every object in it. */
  deleteGroup: (id: string) => void;
  /** Merges the folder's objects into one, the way M merges a selection. */
  joinGroup: (id: string) => void;
  /** Drops the folder, leaving its objects loose in the scene. */
  ungroup: (id: string) => void;
  /** Takes one object out of its folder, leaving the rest of the folder alone. */
  removeFromGroup: (id: string) => void;
  /**
   * Moves one object to another place in the outliner, which is what dragging
   * a row does: it reorders the list and sets the folder in one act, since
   * where a row lands says both.
   */
  moveObject: (id: string, target: MoveTarget) => void;
  /** Hides the whole folder, or shows it again once all of it is hidden. */
  toggleGroupVisibility: (id: string) => void;
  /** Locks the whole folder, or unlocks it again once all of it is locked. */
  toggleGroupLock: (id: string) => void;
  toggleGroupCollapsed: (id: string) => void;
  /**
   * Cuts the selected objects against the active one, which keeps the result.
   *
   * Asynchronous so the status bar can move while it runs: a cut between two
   * dense meshes takes seconds, and it pauses between stages to let the window
   * repaint. The mesh is not touched until every tool has been applied.
   */
  booleanWithSelected: (op: BooleanOp) => Promise<void>;
  separateLooseParts: () => void;
  /** Deletes the selection, or the objects named: the outliner's row menu names one. */
  deleteSelected: (ids?: readonly string[]) => void;
  /** Bakes the selection's transforms, or those of the objects named. */
  applyTransformToSelected: (ids?: readonly string[]) => void;
  originToGeometry: (ids?: readonly string[]) => void;
  setObjectTransform: (id: string, transform: Partial<SceneObject['transform']>) => void;
  setObjectTransforms: (
    patches: { id: string; transform: Partial<SceneObject['transform']> }[],
  ) => void;
  setCursor: (position: Vec3, status?: string) => void;
  /** Puts the cursor on one of the targets the pointer resolved, or says why not. */
  snapCursor: (kind: CursorSnapKind, targets: CursorSnapTargets | null) => void;
  cursorToSelection: () => void;
  cursorToSelectionOrigin: () => void;
  selectionToCursor: () => void;
  /** Moves the origins of the selection, or of the objects named, onto the cursor. */
  originToCursor: (ids?: readonly string[]) => void;

  addMaterial: () => void;
  updateMaterial: (index: number, patch: Partial<Material>) => void;
  /** Drops a slot and rehomes the faces that were wearing it. */
  removeMaterial: (index: number) => void;
  setActiveMaterial: (index: number) => void;
  assignMaterialToSelection: () => void;

  addModifier: (type: Modifier['type']) => void;
  updateModifier: (id: string, patch: Partial<Modifier>) => void;
  removeModifier: (id: string) => void;
  moveModifier: (id: string, direction: -1 | 1) => void;
  applyModifierToMesh: (id: string) => void;
  /** Fits a new cage around the active object and points its lattice modifier `id` at it. */
  addLatticeCage: (id: string) => void;
  /**
   * Rebuilds a cage at another resolution. Its points are placed where the old
   * grid had carried them, so the shape it gave its mesh holds.
   */
  setLatticeResolution: (cageId: string, resolution: LatticeResolution) => void;
  /** Puts every point of a cage back where it rests, letting its mesh go. */
  resetLattice: (cageId: string) => void;

  /**
   * Runs a named operator, recording a step to undo back to, and hands back
   * what it reported, or null when it never ran.
   *
   * `record: false` runs it without one, for a tick of a continuous edit: a
   * scrubbed field hands the operator a new value on every pointer move, and
   * the gesture records its own step when the drag begins rather than one per
   * tick. Whoever passes it owns that step.
   *
   * `throws: true` hands a failure or a refusal back as an error instead of
   * putting it on screen, for a caller that reports it itself: a script stops
   * at the first one, and a toast per refusal on top of its own would say the
   * same thing twice.
   */
  exec: (
    name: string,
    params?: Record<string, unknown>,
    label?: string,
    options?: { record?: boolean; throws?: boolean },
  ) => OperatorResult | null;
  /**
   * Says which operator a gesture ran, for one that ran it itself rather than
   * through `exec`: a bevel, inset or extrude drag previews on a copy of the
   * mesh and keeps the last copy, so only the gesture knows the distance it
   * ended on.
   */
  noteOperator: (name: string, params: Record<string, unknown>, label?: string) => void;
  /**
   * Runs `work` as one step to undo, or as nothing at all.
   *
   * The edits inside it record no steps of their own, and the one step is only
   * kept when the scene changed. When `work` throws, the scene goes back to how
   * it stood before it began and the error carries on to the caller: a script
   * that fails halfway leaves nothing behind for the next run to pile onto.
   */
  transact: <T>(label: string, work: () => Promise<T>) => Promise<T>;
  /**
   * Says the scene now matches what is stored, for the autosave and for
   * whatever put the opening scene on screen. `fingerprint` is the stored
   * scene's, left out when nothing was stored, as for the opening cube.
   */
  markSaved: (fingerprint?: number) => void;
  /**
   * Says it does not, for a write that failed after being counted as done,
   * which leaves nothing stored known to hold the scene.
   */
  markDirty: () => void;
  /** Says a write has landed, so the status bar can show that it did. */
  noteAutosaved: () => void;
  /** Says this scene is now in a file on disk, for a save and for an open. */
  markFileSaved: () => void;
  /** Says which file SAVE writes over from here on, or that there is none. */
  setProjectFile: (file: FileSystemFileHandle | null) => void;
  /** Says where the numbered copies go, and whether they may go there yet. */
  setAutosaveLocation: (location: FileSystemDirectoryHandle | null, ready: boolean) => void;
  recordHistory: (label: string) => void;
  /**
   * Records a document captured earlier rather than the one on screen now.
   *
   * For an edit that stands as a preview before it is committed: the state to
   * undo back to is the one from before the preview, which by then is no longer
   * what `snapshotDocument` would return.
   */
  recordHistoryDocument: (label: string, document: ProjectDocument) => void;
  /** Forgets the last recorded entry, for an operation that was cancelled. */
  discardHistory: () => void;
  undo: () => void;
  redo: () => void;
  /** Steps several entries back at once, for a click into the history dialog. */
  undoTimes: (count: number) => void;
  redoTimes: (count: number) => void;
  /** Re-caps the timeline, dropping the oldest steps the new size cannot hold. */
  setHistoryLimit: (limit: number) => void;
  /**
   * Forgets every step, without touching the scene.
   *
   * For a file opened over the session already running: the steps behind the
   * old project would otherwise still be there, and one Ctrl+Z would undo into
   * a scene the file never held.
   */
  clearHistory: () => void;
  touchMesh: (status?: string) => void;

  /**
   * `restoreLayout` puts the folded panels back too, for a file load, not for undo.
   *
   * `assets` replaces the loaded binaries wholesale, and is how a `.3doo`
   * brings its images with it. Leaving it out keeps the ones already in the
   * session, which is what an undo wants.
   */
  loadProjectDocument: (
    document: ProjectDocument,
    restoreLayout?: boolean,
    assets?: readonly SceneAsset[],
  ) => void;
  snapshotDocument: () => ProjectDocument;
  setProjectName: (name: string) => void;
  resetScene: () => void;
}

export const createSceneSlice: StateCreator<
  EditorStore,
  [['zustand/subscribeWithSelector', never]],
  [],
  SceneSlice
> = (set, get) => ({
  objects: [],
  groups: [],
  assets: {},
  activeObjectId: null,
  selectedObjectIds: [],
  cursor: vec3(),
  projectName: 'untitled',
  meshVersion: 0,
  canUndo: false,
  canRedo: false,
  historyUndo: [],
  historyRedo: [],
  status: 'Ready',
  dirty: false,
  savedFingerprint: null,
  savedToFile: false,
  projectFile: null,
  autosaveLocation: null,
  autosaveLocationReady: false,
  lastOperator: null,
  lockedAttempt: null,
  recentVerts: null,
  autosaveToken: 0,

  touchMesh: (status) =>
    set((state) => ({
      meshVersion: state.meshVersion + 1,
      ...(status ? { status } : {}),
    })),

  snapshotDocument: () => {
    const { projectName, objects, groups, cursor, activeObjectId, collapsedPanels, assets } = get();
    return {
      ...serializeProject(
        projectName,
        objects as SceneObjectSnapshot[],
        cursor,
        activeObjectId,
        groups,
        assetMetadata(assets),
      ),
      panels: { ...collapsedPanels },
    };
  },

  markSaved: (fingerprint) => set({ dirty: false, savedFingerprint: fingerprint ?? null }),

  markDirty: () => set({ dirty: true, savedFingerprint: null }),

  noteAutosaved: () => set((state) => ({ autosaveToken: state.autosaveToken + 1 })),

  markFileSaved: () => set({ savedToFile: true }),

  setProjectFile: (file) => set({ projectFile: file }),

  setAutosaveLocation: (location, ready) =>
    set({ autosaveLocation: location, autosaveLocationReady: location !== null && ready }),

  recordHistory: (label) => get().recordHistoryDocument(label, get().snapshotDocument()),

  recordHistoryDocument: (label, document) => {
    if (historyHold > 0) return;
    history.record(label, document);
    set(historyState());
  },

  transact: async (label, work) => {
    const before = get().snapshotDocument();
    const { selectedObjectIds } = get();
    const signal = (state: EditorStore) =>
      [state.meshVersion, state.objects, state.groups, state.cursor, state.assets] as const;
    const untouched = signal(get());

    historyHold += 1;
    let result: Awaited<ReturnType<typeof work>>;
    try {
      result = await work();
    } catch (error) {
      get().loadProjectDocument({ ...before, name: get().projectName });
      // The load keeps only the active object selected; what else was picked
      // before the run was not the run's to drop.
      const restored = new Set(get().objects.map((object) => object.id));
      set({ selectedObjectIds: selectedObjectIds.filter((id) => restored.has(id)) });
      throw error;
    } finally {
      historyHold -= 1;
    }

    const changed = signal(get()).some((value, index) => value !== untouched[index]);
    if (changed) get().recordHistoryDocument(label, before);
    return result;
  },

  addPrimitive: (kind, params) => {
    get().recordHistory(`Add ${PRIMITIVE_LABELS[kind]}`);

    const resolved = normalizePrimitiveParams({
      ...DEFAULT_PRIMITIVE_PARAMS,
      ...PRIMITIVE_DEFAULT_OVERRIDES[kind],
      ...params,
    });
    const mesh = createPrimitive(kind, resolved);
    const transform = createTransform();
    transform.position = { ...get().cursor };

    const object: SceneObject = {
      id: nextObjectId(),
      name: PRIMITIVE_LABELS[kind],
      mesh,
      transform,
      visible: true,
      locked: false,
      parentId: null,
      groupId: null,
      materials: [defaultMaterial()],
      modifiers: [],
      activeMaterial: 0,
      primitive: { kind, params: resolved },
      image: null,
      lattice: null,
    };

    set((state) => ({
      objects: [...state.objects, object],
      activeObjectId: object.id,
      selectedObjectIds: [object.id],
      meshVersion: state.meshVersion + 1,
      // Placing is what you do next with something you just added, and the
      // gizmo only draws for a transform tool: under the default 'select' a
      // new primitive arrives with nothing to grab. Set here rather than
      // through `setActiveTool`, whose status would bury "Added CUBE".
      activeTool: 'move',
      status: `Added ${PRIMITIVE_LABELS[kind]}`,
    }));
  },

  addImage: (asset) => {
    const name = asset.name.toUpperCase();
    get().recordHistory(`Add ${name}`);

    const { width, height } = imagePlaneSize(asset.width, asset.height);
    const mesh = createImagePlane(width, height);
    const transform = createTransform();

    const object: SceneObject = {
      id: nextObjectId(),
      name,
      mesh,
      transform,
      visible: true,
      locked: false,
      parentId: null,
      groupId: null,
      materials: [defaultMaterial()],
      modifiers: [],
      activeMaterial: 0,
      primitive: null,
      image: { assetId: asset.id },
      lattice: null,
    };

    set((state) => ({
      assets: { ...state.assets, [asset.id]: asset },
      objects: [...state.objects, object],
      activeObjectId: object.id,
      selectedObjectIds: [object.id],
      meshVersion: state.meshVersion + 1,
      activeTool: 'move',
      status: `Imported ${name}`,
    }));
  },

  addImportedObjects: (imported, source) => {
    if (imported.length === 0) return;
    get().recordHistory(`Import ${source}`);

    const { cursor } = get();
    const objects: SceneObject[] = imported.map((entry) => ({
      id: nextObjectId(),
      name: entry.name.toUpperCase(),
      mesh: entry.mesh,
      transform: { ...createTransform(), position: add(cursor, entry.position) },
      visible: true,
      locked: false,
      parentId: null,
      groupId: null,
      materials: [defaultMaterial()],
      modifiers: [],
      activeMaterial: 0,
      primitive: null,
      image: null,
      lattice: null,
    }));

    set((state) => ({
      objects: [...state.objects, ...objects],
      activeObjectId: objects[objects.length - 1].id,
      selectedObjectIds: objects.map((object) => object.id),
      meshVersion: state.meshVersion + 1,
      activeTool: 'move',
      status: `Imported ${source}`,
    }));
  },

  /**
   * Replaces the active object with a patched copy.
   *
   * Every field other than `mesh` has to be swapped by reference rather than
   * mutated: panels select the object itself, so an in-place edit leaves the
   * selector returning an identical reference and nothing re-renders. Geometry
   * is the exception: it is mutated in place and tracked by `meshVersion`.
   */
  patchActiveObject: (patch, options = {}) => {
    const object = activeObject(get());
    if (!object) return;

    const changes = typeof patch === 'function' ? patch(object) : patch;
    if (!changes) return;

    set((state) => ({
      objects: state.objects.map((candidate) =>
        candidate.id === object.id ? { ...candidate, ...changes } : candidate,
      ),
      meshVersion: options.touchGeometry === false ? state.meshVersion : state.meshVersion + 1,
      ...(options.status ? { status: options.status } : {}),
    }));
  },

  /** Live primitive parameters stay editable until the next operation commits. */
  updatePrimitiveParams: (params) => {
    const object = activeObject(get());
    if (!object?.primitive) return;

    const { kind } = object.primitive;
    const asked = { ...object.primitive.params, ...params };
    const resolved = normalizePrimitiveParams(asked);
    const mesh = createPrimitive(kind, resolved);
    const previous = object.mesh;

    // A length the user dialled below the floor comes back raised, and the
    // field it was typed into shows the floor rather than the figure: without
    // a word here the panel simply stops responding to the drag.
    const held = [...METRE_PARAMS].some(
      (field) => params[field] !== undefined && resolved[field] !== asked[field],
    );
    const warning = sizeFloorWarning('length', [{ object, held }]);

    set((state) => ({
      objects: state.objects.map((candidate) => {
        if (candidate.id === object.id) {
          return { ...candidate, mesh, primitive: { kind, params: resolved } };
        }
        // Rebuilding a primitive replaces the instance rather than editing it,
        // so anything linked to the old one is moved across too, otherwise a
        // linked duplicate silently stops following the object it was cut from.
        return candidate.mesh === previous ? { ...candidate, mesh } : candidate;
      }),
      meshVersion: state.meshVersion + 1,
      status: warning ?? state.status,
    }));

    if (warning) get().pushToast('warning', warning);
  },

  setActiveObject: (id, intent = 'replace') => {
    if (id === null) {
      set({ activeObjectId: null, selectedObjectIds: [] });
      return;
    }

    if (intent === 'subtract') {
      get().deselectObject(id);
      return;
    }

    set((state) => {
      const selected =
        intent === 'add'
          ? state.selectedObjectIds.includes(id)
            ? state.selectedObjectIds
            : [...state.selectedObjectIds, id]
          : [id];
      return { activeObjectId: id, selectedObjectIds: selected };
    });

    // Selecting a locked object is allowed, but nothing can be done with it,
    // say so on the click rather than letting the user find out on a failed edit.
    const object = get().objects.find((candidate) => candidate.id === id);
    if (object?.locked) get().noteLockedAttempt(id);
  },

  /**
   * Selects a set of objects at once, for a region drag in object mode.
   *
   * The last one named becomes active, the way the last one clicked would.
   * ADD keeps what was already selected and joins the drag's catch to it,
   * SUBTRACT drops that catch and leaves the rest standing, and a replacing
   * drag that caught nothing clears the selection rather than leaving the last
   * one behind, the same as clicking empty space.
   */
  selectObjects: (ids, intent = 'replace') => {
    set((state) => {
      if (intent === 'subtract') {
        const selected = state.selectedObjectIds.filter((id) => !ids.includes(id));
        return {
          selectedObjectIds: selected,
          // The active object has to be one of the survivors, or the outliner
          // draws a deselected row as the active one.
          activeObjectId:
            state.activeObjectId && selected.includes(state.activeObjectId)
              ? state.activeObjectId
              : (selected[selected.length - 1] ?? null),
        };
      }

      const additive = intent === 'add';
      const selected = additive
        ? [...state.selectedObjectIds, ...ids.filter((id) => !state.selectedObjectIds.includes(id))]
        : [...ids];

      return {
        selectedObjectIds: selected,
        activeObjectId: ids[ids.length - 1] ?? (additive ? state.activeObjectId : null),
      };
    });
  },

  /**
   * Drops one object from the selection.
   *
   * Whatever is left selected takes the active slot when the object dropped
   * was holding it, since the outliner would otherwise go on drawing a
   * deselected row as the active one.
   */
  deselectObject: (id) => {
    set((state) => {
      if (!state.selectedObjectIds.includes(id)) return {};

      const selected = state.selectedObjectIds.filter((candidate) => candidate !== id);
      return {
        selectedObjectIds: selected,
        activeObjectId:
          state.activeObjectId === id
            ? (selected[selected.length - 1] ?? null)
            : state.activeObjectId,
      };
    });
  },

  /**
   * Empties the selection in whichever mode is live.
   *
   * The handles go with it, since the viewport has nothing left to seat them
   * on, but the tool stays as it was: it is the user's own choice, and picking
   * something else is not a request to change it.
   *
   * No history entry, unlike Alt+A: Escape is the way out of a state, and
   * filling undo with the times someone reached for it would bury the edits
   * they actually want back.
   */
  clearSelection: () => {
    const { mode } = get();

    if (mode === 'edit') {
      const object = activeObject(get());
      object?.mesh.deselectAll();
      set((state) => ({ meshVersion: state.meshVersion + 1 }));
    } else {
      set({ selectedObjectIds: [], activeObjectId: null });
    }

    set({ status: 'Deselected all' });
  },

  /** The object-mode equivalent of "select all" in edit mode. */
  selectAllObjects: () => {
    set((state) => ({
      selectedObjectIds: state.objects.map((object) => object.id),
      activeObjectId: state.activeObjectId ?? state.objects[state.objects.length - 1]?.id ?? null,
      status: `Selected all ${state.objects.length} object(s)`,
    }));
  },

  renameObject: (id, name) => {
    set((state) => ({
      objects: state.objects.map((object) => (object.id === id ? { ...object, name } : object)),
    }));
  },

  toggleObjectVisibility: (id) => {
    set((state) => ({
      objects: state.objects.map((object) =>
        object.id === id ? { ...object, visible: !object.visible } : object,
      ),
      meshVersion: state.meshVersion + 1,
    }));
  },

  toggleObjectLock: (id) => {
    set((state) => ({
      objects: state.objects.map((object) =>
        object.id === id ? { ...object, locked: !object.locked } : object,
      ),
    }));
  },

  clearRecentVerts: () => set({ recentVerts: null }),

  noteLockedAttempt: (objectId) => {
    lockAttemptCounter += 1;
    set({ status: 'Object is locked', lockedAttempt: { objectId, token: lockAttemptCounter } });
  },

  duplicateSelected: (linked = false) => {
    const { objects, selectedObjectIds } = get();
    if (selectedObjectIds.length === 0) return;
    get().recordHistory(linked ? 'Linked duplicate' : 'Duplicate');

    const copies: SceneObject[] = [];
    for (const object of objects) {
      if (!selectedObjectIds.includes(object.id)) continue;
      copies.push({
        ...object,
        id: nextObjectId(),
        name: `${object.name}.COPY`,
        // A linked duplicate shares the mesh instance; a full copy clones it.
        mesh: linked ? object.mesh : cloneMesh(object.mesh),
        transform: structuredClone(object.transform),
        materials: structuredClone(object.materials),
        modifiers: structuredClone(object.modifiers),
        primitive: null,
      });
    }

    set((state) => ({
      objects: [...state.objects, ...copies],
      selectedObjectIds: copies.map((object) => object.id),
      activeObjectId: copies[copies.length - 1]?.id ?? state.activeObjectId,
      // A copy is made to be put somewhere else, and it lands exactly on top of
      // its original: it arrives selected and already under the move gizmo,
      // rather than invisible until the tool is switched by hand.
      activeTool: 'move',
      meshVersion: state.meshVersion + 1,
      status: `Duplicated ${copies.length} object(s)`,
    }));
  },

  /** Merges the selected objects into the active one, leaving a single object. */
  mergeSelected: () => {
    const state = get();
    const { objects, selectedObjectIds } = state;
    const target = activeObject(state);
    if (!target) return;
    if (target.locked) {
      get().noteLockedAttempt(target.id);
      return;
    }

    const sources = objects.filter(
      (object) =>
        object.id !== target.id && selectedObjectIds.includes(object.id) && !object.locked,
    );
    if (sources.length === 0) {
      set({ status: 'Select the objects to merge, then the one to merge them into' });
      return;
    }
    if (target.lattice || sources.some((object) => object.lattice)) {
      set({ status: 'A cage cannot be merged: it is a grid of points, not part of a mesh' });
      return;
    }

    get().recordHistory('Merge');

    set((state) => {
      const objects = foldInto(state.objects, target, sources);
      return {
        objects,
        // A merge can swallow every object a folder held, and a folder with
        // nothing in it is not a folder.
        groups: pruneGroups(state.groups, objects),
        selectedObjectIds: [target.id],
        activeObjectId: target.id,
        meshVersion: state.meshVersion + 1,
        status: `Merged ${sources.length + 1} objects`,
      };
    });
  },

  groupSelected: () => {
    const { objects, selectedObjectIds, groups } = get();
    const members = objects.filter((object) => selectedObjectIds.includes(object.id));
    if (members.length === 0) {
      set({ status: 'Select the objects to group first' });
      return;
    }

    get().recordHistory('Group');

    const group: SceneGroup = { id: nextGroupId(), name: groupName(groups), collapsed: false };
    const moving = new Set(members.map((object) => object.id));

    set((state) => {
      const next = state.objects.map((object) =>
        moving.has(object.id) ? { ...object, groupId: group.id } : object,
      );
      return {
        objects: next,
        // Prune before the new one goes in: the objects it took may have been
        // the last of another folder.
        groups: [...pruneGroups(state.groups, next), group],
        status: `Grouped ${members.length} object(s) into ${group.name}`,
      };
    });
  },

  renameGroup: (id, name) => {
    set((state) => ({
      groups: state.groups.map((group) => (group.id === id ? { ...group, name } : group)),
    }));
  },

  selectGroup: (id) => {
    const { objects, groups } = get();
    const group = groups.find((candidate) => candidate.id === id);
    if (!group) return;

    const members = groupMembers(objects, id);
    get().selectObjects(members.map((object) => object.id));
    set({ status: `Selected ${members.length} object(s) in ${group.name}` });
  },

  deleteGroup: (id) => {
    const { objects, groups } = get();
    const group = groups.find((candidate) => candidate.id === id);
    if (!group) return;

    const doomed = new Set(groupMembers(objects, id).map((object) => object.id));
    get().recordHistory('Delete group');

    set((state) => {
      const remaining = state.objects.filter((object) => !doomed.has(object.id));
      return {
        objects: remaining,
        groups: state.groups.filter((candidate) => candidate.id !== id),
        selectedObjectIds: state.selectedObjectIds.filter((objectId) => !doomed.has(objectId)),
        activeObjectId: doomed.has(state.activeObjectId ?? '')
          ? (remaining[remaining.length - 1]?.id ?? null)
          : state.activeObjectId,
        meshVersion: state.meshVersion + 1,
        status: `Deleted ${group.name} and its ${doomed.size} object(s)`,
      };
    });
  },

  joinGroup: (id) => {
    const state = get();
    const group = state.groups.find((candidate) => candidate.id === id);
    if (!group) return;

    const members = groupMembers(state.objects, id);
    const unlocked = members.filter((object) => !object.locked);
    if (unlocked.length === 0) {
      if (members[0]) get().noteLockedAttempt(members[0].id);
      return;
    }

    // The active object keeps the result when it is one of them, so joining
    // from the folder menu lands where joining by hand would.
    const target = unlocked.find((object) => object.id === state.activeObjectId) ?? unlocked[0];
    const sources = unlocked.filter((object) => object.id !== target.id);
    if (sources.length === 0) {
      set({ status: `Nothing to join: ${group.name} holds one unlocked object` });
      return;
    }

    get().recordHistory('Join group');

    set((state) => ({
      objects: foldInto(state.objects, target, sources),
      selectedObjectIds: [target.id],
      activeObjectId: target.id,
      meshVersion: state.meshVersion + 1,
      // The target is a member, so the folder keeps it and survives.
      status: `Joined ${sources.length + 1} objects of ${group.name}`,
    }));
  },

  ungroup: (id) => {
    const group = get().groups.find((candidate) => candidate.id === id);
    if (!group) return;

    get().recordHistory('Ungroup');

    set((state) => ({
      objects: state.objects.map((object) =>
        object.groupId === id ? { ...object, groupId: null } : object,
      ),
      groups: state.groups.filter((candidate) => candidate.id !== id),
      status: `Ungrouped ${group.name}`,
    }));
  },

  removeFromGroup: (id) => {
    const state = get();
    const object = state.objects.find((candidate) => candidate.id === id);
    const group = state.groups.find((candidate) => candidate.id === object?.groupId);
    if (!object || !group) return;

    get().recordHistory('Remove from group');

    set((state) => {
      const next = state.objects.map((candidate) =>
        candidate.id === id ? { ...candidate, groupId: null } : candidate,
      );
      return {
        objects: next,
        // The object may have been the last one in there, and a folder nothing
        // can be put back into is worth no row.
        groups: pruneGroups(state.groups, next),
        status: `Removed ${object.name} from ${group.name}`,
      };
    });
  },

  moveObject: (id, target) => {
    const state = get();
    const object = state.objects.find((candidate) => candidate.id === id);
    if (!object) return;

    const anchor =
      target.kind === 'object'
        ? state.objects.find((candidate) => candidate.id === target.objectId)
        : null;
    if (target.kind === 'object' && (!anchor || anchor.id === id)) return;
    if (target.kind === 'group' && !state.groups.some((group) => group.id === target.groupId)) {
      return;
    }

    const groupId = target.kind === 'group' ? target.groupId : (anchor?.groupId ?? null);

    // The list is one array, and both the loose rows and a folder's members
    // read their order off it, so the move is a single splice either way.
    const rest = state.objects.filter((candidate) => candidate.id !== id);
    let at: number;
    if (target.kind === 'object') {
      at = rest.findIndex((candidate) => candidate.id === target.objectId) + (target.after ? 1 : 0);
    } else {
      // Behind the folder's last member, or at the end of the list when the
      // moved object was the only thing in there.
      const last = rest.map((candidate) => candidate.groupId).lastIndexOf(groupId);
      at = last === -1 ? rest.length : last + 1;
    }
    const next = [...rest.slice(0, at), { ...object, groupId }, ...rest.slice(at)];

    const settled = next.every(
      (candidate, position) =>
        candidate.id === state.objects[position].id &&
        candidate.groupId === state.objects[position].groupId,
    );
    if (settled) return;

    const from = state.groups.find((group) => group.id === object.groupId);
    const into = state.groups.find((group) => group.id === groupId);
    const status =
      groupId === object.groupId
        ? `Reordered ${object.name}`
        : into
          ? `Moved ${object.name} into ${into.name}`
          : `Moved ${object.name} out of ${from?.name ?? 'its folder'}`;

    get().recordHistory(groupId === object.groupId ? 'Reorder' : 'Move object');

    set((state) => ({
      objects: next,
      // The folder it left may have held nothing else.
      groups: pruneGroups(state.groups, next),
      status,
    }));
  },

  toggleGroupVisibility: (id) => {
    set((state) => {
      const members = groupMembers(state.objects, id);
      if (members.length === 0) return {};

      // Hidden only once every member is: a folder holding one visible object
      // still has something to hide.
      const visible = members.every((object) => !object.visible);
      return {
        objects: state.objects.map((object) =>
          object.groupId === id ? { ...object, visible } : object,
        ),
        meshVersion: state.meshVersion + 1,
      };
    });
  },

  toggleGroupLock: (id) => {
    set((state) => {
      const members = groupMembers(state.objects, id);
      if (members.length === 0) return {};

      const locked = !members.every((object) => object.locked);
      return {
        objects: state.objects.map((object) =>
          object.groupId === id ? { ...object, locked } : object,
        ),
      };
    });
  },

  toggleGroupCollapsed: (id) => {
    set((state) => ({
      groups: state.groups.map((group) =>
        group.id === id ? { ...group, collapsed: !group.collapsed } : group,
      ),
    }));
  },

  booleanWithSelected: async (op) => {
    const state = get();
    if (state.busy) return;
    const { objects, selectedObjectIds } = state;
    const target = activeObject(state);
    if (!target) {
      set({ status: 'Select a cutter and the object to cut it against' });
      return;
    }
    if (target.locked) {
      get().noteLockedAttempt(target.id);
      return;
    }

    const tools = objects.filter(
      (object) =>
        object.id !== target.id && selectedObjectIds.includes(object.id) && !object.locked,
    );
    if (tools.length === 0) {
      set({ status: `Select a cutter as well: ${target.name} is the one that keeps the result` });
      return;
    }
    if ([target, ...tools].some((object) => object.lattice)) {
      set({ status: 'A cage has no surface for a boolean to cut' });
      return;
    }

    // A boolean reads the mesh under the stack, not the shape the stack draws:
    // cutting against a sphere with a live REMESH would use the sphere it was
    // built from and hand back a result matching nothing on screen. Refused
    // rather than quietly evaluated, because applying a stack is destructive
    // and is the user's call to make, not this operation's.
    const unapplied = [target, ...tools].filter((object) =>
      object.modifiers.some((modifier) => modifier.enabled),
    );
    if (unapplied.length > 0) {
      const names = unapplied.map((object) => object.name).join(', ');
      get().pushToast(
        'error',
        `Apply the modifiers on ${names} first: a boolean cuts the mesh underneath the stack, not the shape you see.`,
      );
      set({ status: `Apply the modifiers on ${names} before a boolean` });
      return;
    }

    get().recordHistory(BOOLEAN_LABELS[op]);

    // No clone guard as in a merge: each pass builds a new mesh rather than
    // writing into the old one, so an object linked to the target's mesh keeps
    // the shape it had. The target simply stops sharing it.
    const materials = [...target.materials];
    let mesh = target.mesh;

    for (const [index, tool] of tools.entries()) {
      // An uncoloured cutter material takes the target's first slot.
      const slots = mergeMaterialSlots(materials, tool.materials, 0);

      const matrix = composeMatrix(tool.transform);
      const inPlace = () =>
        booleanMeshStaged(
          op,
          mesh,
          tool.mesh,
          (point) => inverseTransformPoint(target.transform, transformPoint(matrix, point)),
          (face) => slots[face.materialIndex] ?? 0,
        );

      // Each tool is a slice of the bar, so cutting with three of them runs
      // once from end to end rather than three times from zero.
      const staged = (cut: Generator<number, BMesh> | AsyncGenerator<number, BMesh>) =>
        get().runStaged(
          BOOLEAN_LABELS[op].toUpperCase(),
          (async function* () {
            let step = await cut.next();
            while (!step.done) {
              yield (index + step.value) / tools.length;
              step = await cut.next();
            }
            return step.value;
          })(),
        );

      // A worker where there is one. The cut is the same either way; what the
      // worker buys is a window that keeps drawing, because a dense boolean
      // holds whichever thread runs it for seconds and nothing else on that
      // thread gets a turn. Nothing has been written yet at this point, so a
      // worker that never started can simply be done again here.
      if (!canRunOffThread()) {
        mesh = await staged(inPlace());
      } else {
        try {
          mesh = await staged(
            booleanOffThread(op, mesh, tool.mesh, target.transform, tool.transform, slots),
          );
        } catch (error) {
          if (!(error instanceof WorkerUnavailable)) throw error;
          mesh = await staged(inPlace());
        }
      }
    }

    const consumed = new Set(tools.map((object) => object.id));
    set((state) => {
      const objects = state.objects
        .filter((object) => !consumed.has(object.id))
        .map((object) =>
          object.id === target.id
            ? // The parameters described a primitive shape the result is not.
              // A cut can take away the very part the origin was sitting in, so
              // the origin goes back on what the boolean left behind.
              recenterOrigin({ ...object, mesh, materials, primitive: null })
            : object,
        );

      return {
        objects,
        // The cutters are gone, and a folder that held nothing else goes too.
        groups: pruneGroups(state.groups, objects),
        selectedObjectIds: [target.id],
        activeObjectId: target.id,
        meshVersion: state.meshVersion + 1,
        status:
          mesh.faces.size === 0
            ? `${BOOLEAN_LABELS[op]} left nothing behind`
            : `${BOOLEAN_LABELS[op]} with ${tools.length} object(s)`,
      };
    });
  },

  /**
   * Breaks the active object's loose parts out into objects of their own.
   *
   * The inverse of a merge, and the reason a merge is not lossy: a part is a
   * shell nothing joins to the rest, so the split is decided by the geometry
   * rather than by the selection. Each part keeps the object's material slots
   * and modifier stack, so nothing re-shades, and each gets its origin on its
   * own middle rather than the shared one it was cut out of, so nothing moves
   * on screen either.
   */
  separateLooseParts: () => {
    const state = get();
    const { objects } = state;
    const object = activeObject(state);
    if (!object) return;
    if (object.locked) {
      get().noteLockedAttempt(object.id);
      return;
    }

    // Separating rewrites the mesh this object holds, which every other user of
    // a linked mesh would be dragged along by.
    if (objects.some((other) => other.id !== object.id && other.mesh === object.mesh)) {
      set({ status: LINKED_MESH_REFUSAL });
      return;
    }

    const parts = splitLooseParts(object.mesh);
    if (parts.length < 2) {
      set({ status: `${object.name} is one connected piece` });
      return;
    }

    get().recordHistory('Separate');

    const [first, ...rest] = parts;
    const separated = rest.map((mesh, index) =>
      recenterOrigin({
        ...object,
        id: nextObjectId(),
        name: `${object.name}.PART.${index + 2}`,
        mesh,
        transform: structuredClone(object.transform),
        materials: structuredClone(object.materials),
        modifiers: structuredClone(object.modifiers),
        // The parameters described the whole shape, not this piece of it.
        primitive: null,
      }),
    );

    set((state) => ({
      objects: state.objects.flatMap((candidate) =>
        candidate.id === object.id
          ? [
              recenterOrigin({
                ...candidate,
                mesh: first,
                name: `${object.name}.PART.1`,
                primitive: null,
              }),
              ...separated,
            ]
          : [candidate],
      ),
      selectedObjectIds: [object.id, ...separated.map((part) => part.id)],
      meshVersion: state.meshVersion + 1,
      status: `Separated ${parts.length} loose parts`,
    }));
  },

  deleteSelected: (ids) => {
    const targetIds = ids ?? get().selectedObjectIds;
    if (targetIds.length === 0) return;
    get().recordHistory('Delete object');

    set((state) => {
      const remaining = state.objects.filter((object) => !targetIds.includes(object.id));
      return {
        objects: remaining,
        groups: pruneGroups(state.groups, remaining),
        // What survived the delete keeps its place in the selection: naming one
        // object from the outliner leaves the rest of a selection alone.
        selectedObjectIds: state.selectedObjectIds.filter((id) => !targetIds.includes(id)),
        activeObjectId: targetIds.includes(state.activeObjectId ?? '')
          ? (remaining[remaining.length - 1]?.id ?? null)
          : state.activeObjectId,
        meshVersion: state.meshVersion + 1,
        status: `Deleted ${targetIds.length} object(s)`,
      };
    });
  },

  /**
   * Bakes rotation and scale into the mesh and resets them to identity.
   *
   * Position is deliberately left alone: the object stays exactly where it
   * sits, and only the numbers behind it change. Everything that reads the raw
   * mesh rather than the world matrix (modifier thickness, bevel width,
   * export) then works on the shape you actually see.
   */
  applyTransformToSelected: (ids) => {
    const { objects, selectedObjectIds } = get();
    const targetIds = ids ?? selectedObjectIds;
    const unlocked = objects.filter((object) => targetIds.includes(object.id) && !object.locked);
    if (unlocked.length === 0) return;
    const targets = unlocked.filter((object) => !object.lattice);
    if (targets.length === 0) {
      set({ status: CAGE_TRANSFORM_REFUSAL });
      return;
    }

    // Baking one object's rotation and scale into a shared mesh would drag
    // every other user of it out of shape alongside it.
    const single = soleMeshUsers(objects, targets);
    if (single.length === 0) {
      set({ status: LINKED_MESH_REFUSAL });
      return;
    }

    get().recordHistory('Apply transform');

    for (const object of single) {
      const { rotation, scale } = object.transform;
      const matrix = composeMatrix({ position: vec3(), rotation, scale });
      for (const vert of object.mesh.verts.values()) vert.co = transformPoint(matrix, vert.co);

      // A negative scale mirrors the mesh. Once it is baked in there is no
      // scale left to flip the winding back, so the faces are turned instead.
      if (scale.x * scale.y * scale.z < 0) {
        flipNormals(object.mesh, [...object.mesh.faces.values()]);
      } else {
        object.mesh.computeNormals();
      }
    }

    const applied = new Set(single.map((object) => object.id));
    set((state) => ({
      objects: state.objects.map((object) =>
        applied.has(object.id)
          ? {
              ...object,
              transform: { ...object.transform, rotation: vec3(), scale: vec3(1, 1, 1) },
              // The primitive parameters described the mesh as it was before
              // the bake; editing them now would regenerate it unrotated.
              primitive: null,
            }
          : object,
      ),
      meshVersion: state.meshVersion + 1,
      status: `Applied rotation and scale to ${single.length} object(s)`,
    }));
  },

  /**
   * Moves each object's origin onto the middle of its own mesh, the way
   * Blender's Set Origin > Origin to Geometry does.
   *
   * Vertices move in edit mode and the origin does not, so geometry dragged
   * across the scene leaves the origin, the gizmo and the ORIGINS marker behind
   * it. This is what brings all three back onto the shape.
   *
   * The middle is the bounding box's centre rather than the average of the
   * vertices: a densely tessellated end would drag an average towards itself,
   * and the point of one click is that it lands where the shape looks centred.
   * Vertices give up exactly what the origin gains, so nothing moves on screen.
   */
  originToGeometry: (ids) => {
    const { objects, selectedObjectIds } = get();
    const targetIds = ids ?? selectedObjectIds;
    const unlocked = objects.filter((object) => targetIds.includes(object.id) && !object.locked);
    if (unlocked.length === 0) {
      set({ status: 'Nothing selected' });
      return;
    }
    const targets = unlocked.filter((object) => !object.lattice);
    if (targets.length === 0) {
      set({ status: CAGE_TRANSFORM_REFUSAL });
      return;
    }

    // Shifting the vertices of a shared mesh would carry every other user of it
    // off its own origin.
    const single = soleMeshUsers(objects, targets);
    if (single.length === 0) {
      set({ status: LINKED_MESH_REFUSAL });
      return;
    }

    // Nothing to record and nothing to say when every origin is already there,
    // so the offsets are read before the history entry rather than after.
    const movable = single.filter((object) => !equals(originOffset(object), vec3()));
    if (movable.length === 0) {
      set({ status: 'Origins are already on the geometry' });
      return;
    }

    get().recordHistory('Origin to geometry');

    const moved = new Map(movable.map((object) => [object.id, recenterOrigin(object)]));

    set((state) => ({
      objects: state.objects.map((object) => moved.get(object.id) ?? object),
      meshVersion: state.meshVersion + 1,
      status: `Origin to geometry on ${moved.size} object(s)`,
    }));
  },

  setObjectTransform: (id, transform) => {
    const object = get().objects.find((candidate) => candidate.id === id);
    if (!object) return;
    if (object.locked) {
      get().noteLockedAttempt(object.id);
      return;
    }

    const next = withScaleFloor(object, transform);
    const warning = sizeFloorWarning('scale', [{ object, held: next.held }]);

    set((state) => ({
      objects: state.objects.map((candidate) =>
        candidate.id === id ? { ...candidate, transform: next.transform } : candidate,
      ),
      meshVersion: state.meshVersion + 1,
      status: warning ?? state.status,
    }));

    if (warning) get().pushToast('warning', warning);
  },

  /**
   * Same as `setObjectTransform`, but for every dragged object in one `set`
   * call. A multi-object gizmo drag patches every selected object on each
   * pointer-move tick; batching keeps that one store update (and one
   * `syncScene`) instead of N.
   *
   * Locked objects are skipped here too: the gizmo already excludes them
   * from the drag group, but this keeps the guarantee at the one place state
   * actually changes rather than trusting every future caller to filter first.
   */
  setObjectTransforms: (patches) => {
    if (patches.length === 0) return;
    const patchMap = new Map(patches.map((patch) => [patch.id, patch.transform]));

    const resolved = new Map<string, SceneObject['transform']>();
    const floored: { object: SceneObject; held: boolean }[] = [];

    for (const object of get().objects) {
      const patch = patchMap.get(object.id);
      if (!patch || object.locked) continue;

      const next = withScaleFloor(object, patch);
      resolved.set(object.id, next.transform);
      floored.push({ object, held: next.held });
    }

    const warning = sizeFloorWarning('scale', floored);

    set((state) => ({
      objects: state.objects.map((object) => {
        const transform = resolved.get(object.id);
        return transform ? { ...object, transform } : object;
      }),
      meshVersion: state.meshVersion + 1,
      status: warning ?? state.status,
    }));

    if (warning) get().pushToast('warning', warning);
  },

  /**
   * Moves the 3D cursor, as an edit of its own.
   *
   * The cursor rides in the document, so undo was already putting it back: what
   * it had no entry for was the move itself, and Ctrl+Z after placing it undid
   * whatever edit came before instead, taking the model with it. One entry per
   * placement is what makes Ctrl+Z give the cursor back and leave the rest of
   * the scene where it stands.
   *
   * A placement that lands where the cursor already is records nothing, so
   * pressing Shift+C twice does not bury the edit behind it.
   */
  setCursor: (position, status = 'Cursor placed') => {
    if (equals(get().cursor, position)) {
      set({ status });
      return;
    }
    get().recordHistory(status);
    set({ cursor: { ...position }, status });
  },

  /**
   * Applies a pointer snap.
   *
   * `targets` is what the pointer resolved to, or null when the pointer is not
   * over the viewport at all: the one refusal the keyboard can hit and the
   * menu, opened by a click inside it, cannot.
   */
  snapCursor: (kind, targets) => {
    if (!targets) {
      set({ status: 'Move the pointer into the viewport to snap the cursor' });
      return;
    }

    const target = targets[kind];
    if (!target) {
      set({ status: CURSOR_SNAPS[kind].missing });
      return;
    }
    get().setCursor(target, CURSOR_SNAPS[kind].label);
  },

  cursorToSelection: () => {
    const anchor = selectionAnchor(get());
    if (!anchor) {
      set({ status: 'Nothing selected' });
      return;
    }
    get().setCursor(anchor, 'Cursor to selection');
  },

  cursorToSelectionOrigin: () => {
    const anchor = selectionOrigin(get());
    if (!anchor) {
      set({ status: 'Nothing selected' });
      return;
    }
    get().setCursor(anchor, 'Cursor to selection origin');
  },

  /**
   * Moves the selection so it lands on the cursor, keeping the offsets between
   * objects. Blender stacks every object origin on the cursor by default; here
   * the group moves as a unit and lands by the middle of its geometry, which is
   * what the user is actually looking at.
   */
  selectionToCursor: () => {
    const state = get();
    const anchor = selectionAnchor(state);
    if (!anchor) {
      set({ status: 'Nothing selected' });
      return;
    }

    const offset = sub(state.cursor, anchor);
    if (state.mode === 'edit') {
      const object = activeObject(state);
      if (!object || object.locked) return;
      state.recordHistory('Selection to cursor');
      // The cursor is a world point but vertices live in object space, so the
      // offset has to come back through the object's own frame.
      const local = inverseTransformOffset(object.transform, offset);
      translateVerts(object.mesh, object.mesh.selectedVerts(), local);
      set((current) => ({ meshVersion: current.meshVersion + 1, status: 'Selection to cursor' }));
      return;
    }

    const movable = state.objects.filter(
      (object) => state.selectedObjectIds.includes(object.id) && !object.locked,
    );
    if (movable.length === 0) return;

    state.recordHistory('Selection to cursor');
    state.setObjectTransforms(
      movable.map((object) => ({
        id: object.id,
        transform: { position: add(object.transform.position, offset) },
      })),
    );
    set({ status: 'Selection to cursor' });
  },

  /**
   * Moves each selected object's origin onto the 3D cursor, the way Blender's
   * Set Origin > Origin to 3D Cursor does.
   *
   * The mirror of `selectionToCursor`: that one carries the geometry to the
   * cursor, this one leaves the geometry where it stands and brings the origin,
   * the gizmo and the ORIGINS marker over instead. Every selected object lands
   * its origin on the same point, so a group of them ends up sharing one.
   */
  originToCursor: (ids) => {
    const { objects, selectedObjectIds, cursor } = get();
    const targetIds = ids ?? selectedObjectIds;
    const unlocked = objects.filter((object) => targetIds.includes(object.id) && !object.locked);
    if (unlocked.length === 0) {
      set({ status: 'Nothing selected' });
      return;
    }
    const targets = unlocked.filter((object) => !object.lattice);
    if (targets.length === 0) {
      set({ status: CAGE_TRANSFORM_REFUSAL });
      return;
    }

    // Shifting the vertices of a shared mesh would carry every other user of it
    // off its own origin.
    const single = soleMeshUsers(objects, targets);
    if (single.length === 0) {
      set({ status: LINKED_MESH_REFUSAL });
      return;
    }

    // Nothing to record and nothing to say when every origin is already there,
    // so the ones that would move are counted before the history entry.
    const movable = single.filter((object) => !equals(object.transform.position, cursor));
    if (movable.length === 0) {
      set({ status: 'Origins are already on the cursor' });
      return;
    }

    get().recordHistory('Origin to cursor');

    const moved = new Map(movable.map((object) => [object.id, moveOrigin(object, cursor)]));

    set((state) => ({
      objects: state.objects.map((object) => moved.get(object.id) ?? object),
      meshVersion: state.meshVersion + 1,
      status: `Origin to cursor on ${moved.size} object(s)`,
    }));
  },

  addMaterial: () => {
    get().patchActiveObject(
      (object) => {
        const materials = [...object.materials, defaultMaterial()];
        return { materials, activeMaterial: materials.length - 1 };
      },
      { touchGeometry: false },
    );
  },

  updateMaterial: (index, patch) => {
    get().patchActiveObject((object) =>
      object.materials[index]
        ? {
            materials: object.materials.map((material, i) =>
              i === index ? { ...material, ...patch } : material,
            ),
          }
        : null,
    );
  },

  /**
   * Deletes a material slot.
   *
   * Slots are addressed by position, so removing one renumbers every slot after
   * it. Faces are rewritten to match: the ones past the gap follow the material
   * they were already wearing down a place, and the ones wearing the deleted
   * slot fall back to the first: a face always points at a slot that exists.
   */
  removeMaterial: (index) => {
    const object = activeObject(get());
    const material = object?.materials[index];
    if (!object || !material) return;

    get().recordHistory(`Delete ${material.name}`);

    for (const face of object.mesh.faces.values()) {
      if (face.materialIndex === index) face.materialIndex = 0;
      else if (face.materialIndex > index) face.materialIndex -= 1;
    }

    const materials = object.materials.filter((_, slot) => slot !== index);
    get().patchActiveObject(
      {
        materials,
        activeMaterial: Math.max(0, Math.min(object.activeMaterial, materials.length - 1)),
      },
      { status: `Deleted ${material.name}` },
    );
  },

  setActiveMaterial: (index) => {
    get().patchActiveObject({ activeMaterial: index }, { touchGeometry: false });
  },

  assignMaterialToSelection: () => {
    const object = activeObject(get());
    if (!object) return;

    get().recordHistory('Assign material');
    for (const face of object.mesh.selectedFaces()) face.materialIndex = object.activeMaterial;

    set((state) => ({
      // Per-face assignments are not something the parameters would rebuild, so
      // the shape stops being live rather than losing them to the next tweak.
      objects: state.objects.map((candidate) =>
        candidate.id === object.id ? { ...candidate, primitive: null } : candidate,
      ),
      meshVersion: state.meshVersion + 1,
      status: `Assigned ${object.materials[object.activeMaterial]?.name ?? 'material'}`,
    }));
  },

  addModifier: (type) => {
    const object = activeObject(get());
    if (!object) return;
    if (object.lattice) {
      set({ status: 'A cage takes no modifiers: it shapes the objects that use it' });
      return;
    }
    get().recordHistory('Add modifier');

    // A lattice with nothing to read does nothing at all, so it arrives with
    // a cage already fitted around the mesh: one step from the menu to a grid
    // of points to pull on.
    const modifier = createModifier(type);
    if (modifier.type === 'lattice') {
      set((state) => withNewCage(state, object, modifier));
      return;
    }
    get().patchActiveObject((current) => ({ modifiers: [...current.modifiers, modifier] }));
  },

  updateModifier: (id, patch) => {
    get().patchActiveObject((object) => ({
      modifiers: object.modifiers.map((modifier) =>
        modifier.id === id ? ({ ...modifier, ...patch } as Modifier) : modifier,
      ),
    }));
  },

  removeModifier: (id) => {
    if (!activeObject(get())) return;
    get().recordHistory('Remove modifier');
    get().patchActiveObject((object) => ({
      modifiers: object.modifiers.filter((modifier) => modifier.id !== id),
    }));
  },

  moveModifier: (id, direction) => {
    get().patchActiveObject((object) => {
      const index = object.modifiers.findIndex((modifier) => modifier.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= object.modifiers.length) return null;

      const reordered = [...object.modifiers];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(target, 0, moved);
      return { modifiers: reordered };
    });
  },

  applyModifierToMesh: (id) => {
    const object = activeObject(get());
    const modifier = object?.modifiers.find((candidate) => candidate.id === id);
    if (!object || !modifier) return;

    get().recordHistory(`Apply ${modifier.name}`);
    get().patchActiveObject(
      {
        mesh: applyModifier(
          cloneMesh(object.mesh),
          modifier,
          modifierContext(object, get().cursor, get().objects),
        ),
        modifiers: object.modifiers.filter((candidate) => candidate.id !== id),
        primitive: null,
      },
      { status: `Applied ${modifier.name}` },
    );
  },

  addLatticeCage: (id) => {
    const object = activeObject(get());
    const modifier = object?.modifiers.find((candidate) => candidate.id === id);
    if (!object || modifier?.type !== 'lattice') return;
    if (object.locked) {
      get().noteLockedAttempt(object.id);
      return;
    }

    get().recordHistory('New cage');
    set((state) => withNewCage(state, object, modifier));
  },

  setLatticeResolution: (cageId, resolution) => {
    const cage = get().objects.find((object) => object.id === cageId);
    if (!cage?.lattice) return;
    if (cage.locked) {
      get().noteLockedAttempt(cage.id);
      return;
    }

    const from = cage.lattice.resolution;
    const next = clampLatticeResolution(resolution);
    if (next.x === from.x && next.y === from.y && next.z === from.z) return;

    get().recordHistory('Cage resolution');
    // A cage whose grid no longer reads starts over at rest, which is all a
    // grid that cannot say which point is which can be resampled from.
    const points = latticePoints(cage.mesh, from);
    const shape = points ? latticeShape(from, points, cage.lattice.shape) : undefined;
    const mesh = createLatticeMesh(
      next,
      shape ? resampleLattice(shape.resolution, shape.points, next) : undefined,
    );
    set((state) =>
      withCageMesh(
        state,
        cage,
        mesh,
        shape ? { resolution: next, shape } : { resolution: next },
        `${cage.name} is ${next.x}×${next.y}×${next.z}`,
      ),
    );
  },

  resetLattice: (cageId) => {
    const cage = get().objects.find((object) => object.id === cageId);
    if (!cage?.lattice) return;
    if (cage.locked) {
      get().noteLockedAttempt(cage.id);
      return;
    }

    const { resolution, shape } = cage.lattice;
    const points = latticePoints(cage.mesh, resolution);
    const rest = latticeRestPoints(resolution);
    // A remembered shape is still something to reset: a grid too coarse to show
    // it would otherwise bring it back the moment the resolution went up again.
    if (!shape && points?.every((point, index) => equals(point, rest[index]))) {
      set({ status: `${cage.name} is already at rest` });
      return;
    }

    get().recordHistory('Reset cage');
    set((state) =>
      withCageMesh(
        state,
        cage,
        createLatticeMesh(resolution),
        { resolution },
        `Reset ${cage.name}`,
      ),
    );
  },

  exec: (name, params = {}, label, options) => {
    const { selectMode, cursor } = get();
    const throws = options?.throws ?? false;
    const object = activeObject(get());
    if (!object) {
      if (throws) throw new Error('No active object');
      set({ status: 'No active object' });
      return null;
    }
    if (object.locked) {
      if (throws) throw new Error(`${object.name} is locked`);
      get().noteLockedAttempt(object.id);
      return null;
    }
    if (object.lattice && !CAGE_OPERATORS.has(name)) {
      if (throws) throw new Error(CAGE_REFUSAL);
      set({ status: CAGE_REFUSAL });
      get().pushToast('warning', CAGE_REFUSAL);
      return null;
    }

    const record = options?.record ?? true;
    if (record) get().recordHistory(label ?? name);

    let result: OperatorResult;
    try {
      result = execOperator(
        {
          mesh: object.mesh,
          selectMode,
          cursor,
          objectScale: object.transform.scale,
        },
        name,
        params,
      );
    } catch (error) {
      const message = `${name} failed: ${(error as Error).message}`;
      if (throws) throw new Error(message);
      set({ status: message });
      get().pushToast('error', message);
      return null;
    }

    // An operator that declined changed nothing, so there is nothing to
    // undo back to and nothing on screen to say what happened.
    if (result.refused) {
      // Only the step this call put there: a tick of a continuous edit
      // recorded none, and dropping one anyway would take back the step the
      // gesture reserved before it started.
      if (record) get().discardHistory();
      if (throws) throw new Error(result.status);
      set({ status: result.status });
      get().pushToast('warning', result.status);
      return result;
    }

    // A structural edit invalidates the primitive's live parameters. The
    // object is replaced rather than mutated so the panels see the change.
    set((state) => ({
      objects: state.objects.map((candidate) =>
        candidate.id === object.id ? { ...candidate, primitive: null } : candidate,
      ),
      meshVersion: state.meshVersion + 1,
      status: result.status,
      recentVerts: result.createdVerts?.length
        ? { objectId: object.id, vertIds: result.createdVerts, token: ++recentVertsCounter }
        : null,
      lastOperator: { name, label: label ?? name, params },
    }));
    return result;
  },

  noteOperator: (name, params, label) =>
    set({ lastOperator: { name, label: label ?? name, params } }),

  discardHistory: () => {
    // The step being taken back was never recorded while a transaction held
    // them, so dropping one here would take an older, real step with it.
    if (historyHold > 0) return;
    history.drop();
    set(historyState());
  },

  undo: () => get().undoTimes(1),

  redo: () => get().redoTimes(1),

  undoTimes: (count) => {
    const steps = Math.min(count, get().historyUndo.length);
    const entry = history.undoTimes(count, get().snapshotDocument());
    if (!entry) {
      set({ status: 'Nothing to undo' });
      return;
    }
    // A rename records no step, so undo leaves the name as it is. The name
    // says which file SAVE writes over, and a step from before a rename would
    // otherwise grey SAVE out.
    get().loadProjectDocument({ ...entry.document, name: get().projectName });
    set({
      ...historyState(),
      // A trip through the dialog says how far it went; a plain Ctrl+Z has only
      // ever named what it took back.
      status: steps > 1 ? `Undo ${steps} steps, back to: ${entry.label}` : `Undo: ${entry.label}`,
    });
  },

  redoTimes: (count) => {
    const steps = Math.min(count, get().historyRedo.length);
    const entry = history.redoTimes(count, get().snapshotDocument());
    if (!entry) {
      set({ status: 'Nothing to redo' });
      return;
    }
    // The name stays put, as it does through an undo.
    get().loadProjectDocument({ ...entry.document, name: get().projectName });
    set({
      ...historyState(),
      status: steps > 1 ? `Redo ${steps} steps, up to: ${entry.label}` : `Redo: ${entry.label}`,
    });
  },

  setHistoryLimit: (limit) => {
    history.setLimit(limit);
    set(historyState());
  },

  clearHistory: () => {
    history.clear();
    set(historyState());
  },

  loadProjectDocument: (document, restoreLayout = false, assets) => {
    const restored = deserializeProject(document);
    // Undo replays the scene, not the shell: a snapshot taken while a panel was
    // folded would otherwise fold it again three operations later.
    if (restoreLayout) get().setCollapsedPanels(document.panels ?? {});
    // A file saved while new ids could repeat old ones may hold two objects
    // under one id, and the viewport draws only one of them. The second gets
    // an id of its own, so both come back on screen.
    const seen = new Set<string>();
    const objects: SceneObject[] = restored.objects.map((object) => {
      const id = seen.has(object.id) ? nextObjectId() : object.id;
      seen.add(id);
      return {
        ...object,
        id,
        primitive: null,
        image: object.image ?? null,
        lattice: object.lattice ?? null,
      };
    });
    // Which folders are folded shut is how the panel looks rather than what the
    // scene is, so it survives the replay an undo runs: a step taken three
    // operations ago has no business folding a group open again.
    const folded = new Map(get().groups.map((group) => [group.id, group.collapsed]));
    const groups: SceneGroup[] = restored.groups.map((group) => ({
      ...group,
      collapsed: folded.get(group.id) ?? false,
    }));

    set((state) => ({
      objects,
      groups,
      // Bytes only arrive with a file being opened. An undo is a replay of the
      // same session, so it keeps the assets already loaded and only takes on
      // the description of any it has never seen, which is how an image
      // survives being deleted and undone.
      assets: assets
        ? Object.fromEntries(assets.map((asset) => [asset.id, asset]))
        : mergedAssets(state.assets, restored.assets),
      projectName: restored.name,
      cursor: restored.cursor,
      activeObjectId: restored.activeObjectId,
      selectedObjectIds: restored.activeObjectId ? [restored.activeObjectId] : [],
      meshVersion: state.meshVersion + 1,
    }));
  },

  setProjectName: (name) => set({ projectName: name }),

  resetScene: () => {
    history.clear();
    heldAtSizeFloor.clear();
    set({
      objects: [],
      groups: [],
      assets: {},
      activeObjectId: null,
      selectedObjectIds: [],
      cursor: vec3(),
      projectName: 'untitled',
      ...historyState(),
      status: 'New project',
      lastOperator: null,
      lockedAttempt: null,
      recentVerts: null,
      meshVersion: get().meshVersion + 1,
      // Edit mode with no object is not a reachable state, so a new scene has
      // to drop back to object mode along with the tool that was active.
      mode: 'object',
      activeTool: 'select',
      modal: null,
      deleteMenu: null,
      dialog: null,
      collapsedPanels: {},
    });
    // After the emptying rather than inside it: subscribers run once the state
    // is in place, so the watcher that raises the flag on a changed scene would
    // raise it again on the way out of the set above.
    // The new scene has never been in a file, whatever the old one had been.
    set({ dirty: false, savedFingerprint: null, savedToFile: false, projectFile: null });
  },
});

/**
 * The object edits land on.
 *
 * Every panel, tool and viewport handler starts from this same lookup, so it is
 * named once here rather than rebuilt at each call site.
 */
export function activeObject(state: {
  objects: readonly SceneObject[];
  activeObjectId: string | null;
}): SceneObject | null {
  return state.objects.find((object) => object.id === state.activeObjectId) ?? null;
}

/**
 * The world-space point the current selection hangs off: the middle of the
 * geometry. In edit mode the median of the selected vertices, in object mode
 * the centre of what each selected object draws.
 *
 * Not the origin the gizmo sits on, deliberately. Snapping the cursor is about
 * putting it on the shape you are looking at, and an edit-mode move can leave
 * an origin metres away from that shape.
 *
 * Null when nothing is selected, which is what the callers report to the user
 * rather than silently snapping to the world origin.
 */
function selectionAnchor(state: EditorStore): Vec3 | null {
  const object = activeObject(state);

  if (state.mode === 'edit') {
    const selected = object?.mesh.selectedVerts() ?? [];
    if (!object || selected.length === 0) return null;
    return transformPoint(composeMatrix(object.transform), medianPoint(selected));
  }

  const selected = state.objects.filter((candidate) =>
    state.selectedObjectIds.includes(candidate.id),
  );
  if (selected.length === 0) return null;
  return centroid(
    selected.map((candidate) =>
      displayCenter(
        candidate,
        evaluatedMesh(candidate, state.cursor, state.meshVersion, state.objects),
      ),
    ),
  );
}

/**
 * Where the selection's origins are, rather than where its geometry is: the
 * median of them in object mode, Blender's rule for snapping to origins.
 *
 * In edit mode it is the edited object's own, since the vertices being picked
 * are not objects and have no origin between them. That is the case it earns
 * its place in: an edit-mode move walks the mesh away from the origin, and this
 * puts the cursor on the point that stayed behind.
 */
function selectionOrigin(state: EditorStore): Vec3 | null {
  if (state.mode === 'edit') {
    const object = activeObject(state);
    return object ? { ...object.transform.position } : null;
  }

  const selected = state.objects.filter((candidate) =>
    state.selectedObjectIds.includes(candidate.id),
  );
  if (selected.length === 0) return null;
  return centroid(selected.map((candidate) => candidate.transform.position));
}

interface EvaluatedStack {
  version: number;
  modifiers: readonly Modifier[];
  cursor: Vec3;
  result: BMesh;
}

/** Last stack result per object, so an unchanged stack is not run twice. */
const evaluatedStacks = new Map<string, EvaluatedStack>();

/**
 * What the stack of `object` reads from the rest of the scene, brought into
 * the object's own space: the 3D cursor, the object's scale, and the cages its
 * lattice modifiers name.
 *
 * A cage that is missing, is not a cage, or no longer holds its grid is left
 * out, and the modifier naming it passes the mesh through untouched.
 */
export function modifierContext(
  object: SceneObject,
  cursor: Vec3,
  objects: readonly SceneObject[],
): ModifierContext {
  const lattices = new Map<string, LatticeCage>();
  for (const modifier of object.modifiers) {
    if (modifier.type !== 'lattice' || !modifier.objectId) continue;
    const cage = objects.find((candidate) => candidate.id === modifier.objectId);
    if (!cage?.lattice || cage.id === object.id || lattices.has(cage.id)) continue;

    const points = latticePoints(cage.mesh, cage.lattice.resolution);
    if (!points) continue;
    lattices.set(cage.id, {
      resolution: cage.lattice.resolution,
      points,
      toCage: multiplyMatrices(inverseMatrix(cage.transform), composeMatrix(object.transform)),
      fromCage: multiplyMatrices(inverseMatrix(object.transform), composeMatrix(cage.transform)),
    });
  }

  return {
    cursor: inverseTransformPoint(object.transform, cursor),
    scale: object.transform.scale,
    lattices,
  };
}

/**
 * Display mesh for an object: its base mesh run through the modifier stack.
 *
 * The 3D cursor arrives in world space and is handed to the kernel in the
 * object's own local frame, which is the only coordinate system a modifier
 * knows about. `objects` is the scene the object stands in, which is where a
 * lattice modifier finds its cage: left out, a lattice shapes nothing.
 *
 * `version` is the store's `meshVersion`, and passing it turns on the memo.
 * The viewport re-syncs on far more than geometry (selecting an object,
 * entering edit mode, changing the shading) and every one of those was
 * re-running the whole stack for every object in the scene. That was tolerable
 * while the dearest modifier was a subdivision; a REMESH is the better part of
 * a second on its own, and without this a click anywhere would pay for it. The
 * mesh is edited in place, so the version is what says it changed; a caller
 * with no version to offer gets a fresh evaluation. Moving a cage, or any of
 * its points, bumps the version as well, so the memo never holds a shape the
 * cage has since pulled elsewhere.
 */
export function evaluatedMesh(
  object: SceneObject,
  cursor: Vec3 = vec3(),
  version?: number,
  objects: readonly SceneObject[] = [],
) {
  if (object.modifiers.length === 0) return object.mesh;

  const cached = evaluatedStacks.get(object.id);
  if (
    version !== undefined &&
    cached &&
    cached.version === version &&
    cached.modifiers === object.modifiers &&
    equals(cached.cursor, cursor, 0)
  ) {
    return cached.result;
  }

  const result = evaluateModifiers(
    object.mesh,
    object.modifiers,
    modifierContext(object, cursor, objects),
  );

  if (version !== undefined) {
    // Entries for objects that have since been deleted would otherwise sit on
    // a display mesh each for the rest of the session.
    if (evaluatedStacks.size > 64) {
      for (const [id, entry] of evaluatedStacks) {
        if (entry.version !== version) evaluatedStacks.delete(id);
      }
    }
    evaluatedStacks.set(object.id, {
      version,
      modifiers: object.modifiers,
      cursor: { ...cursor },
      result,
    });
  }
  return result;
}

/**
 * World-space centre of what an object actually draws.
 *
 * What the 3D cursor snaps to, what the camera frames, and where the gizmo sits
 * on the MEDIAN pivot: all three are about the shape on screen rather than the
 * origin, which may be nowhere near it and which an array modifier carries the
 * geometry away from entirely.
 *
 * Takes the evaluated mesh rather than deriving it, so callers that have
 * already run the modifier stack do not run it twice.
 */
export function displayCenter(object: SceneObject, mesh: BMesh): Vec3 {
  const box = mesh.boundingBox();
  return transformPoint(composeMatrix(object.transform), centroid([box.min, box.max]));
}
