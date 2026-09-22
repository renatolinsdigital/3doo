import { type Vec3, axisVector, degToRad, vec3 } from '../math';
import type { BMesh } from '../mesh';
import type { SelectMode } from '../mesh/types';
import {
  type FalloffCurve,
  type MergeMode,
  DISSOLVE_ANGLE_LIMIT_DEGREES,
  bevelEdges,
  budgetRefusal,
  bridgeEdgeLoops,
  circleVerts,
  connectVerts,
  deleteGeometry,
  dissolveEdges,
  dissolveFaces,
  dissolveVerts,
  extrudeEdges,
  extrudeFaces,
  fillHole,
  flipNormals,
  growSelection,
  hasConnectedEdges,
  insetFaces,
  invertSelection,
  isDissolvableEdge,
  isDissolvableVert,
  limitedDissolve,
  canLoopCut,
  loopCut,
  medianPoint,
  mergeByDistance,
  mergeVerts,
  recalculateNormals,
  relaxVerts,
  rotateVerts,
  scaleVerts,
  selectEdgeLoops,
  selectFaceLoop,
  setEdgeLengths,
  setShading,
  shrinkFatten,
  shrinkSelection,
  spaceVerts,
  subdivideEdges,
  subdivideFaces,
  subdivisionCost,
  translateVerts,
  triangulateFaces,
  trisToQuads,
  vertsAfterEdgeSubdivide,
} from '../ops';

export interface OperatorContext {
  mesh: BMesh;
  selectMode: SelectMode;
  cursor: Vec3;
  proportional?: { enabled: boolean; radius: number; falloff: FalloffCurve };
  /**
   * The scale of the object being edited, for the operators that work in
   * metres. The mesh is stored in the object's own space, so this is what
   * stands between a coordinate in it and a size out in the world.
   */
  objectScale?: Vec3;
}

export type OperatorParams = Record<string, unknown>;

export interface OperatorResult {
  /** Short human-readable summary shown in the status bar. */
  status: string;
  /**
   * The operator declined rather than ran.
   *
   * Nothing was changed, so the caller says it out loud and keeps no undo step
   * for it: an operation refused for being too big to survive is the one the
   * user most needs told about, and the least worth a step back to.
   */
  refused?: boolean;
  /**
   * Vertices the operator just created, for the viewport to flash briefly.
   * A new vertex is easy to lose track of: the midpoint of a subdivided edge
   * lands exactly on the line it split, and in edge mode vertices are not drawn
   * at all, so the viewport marks them until the user's next action.
   */
  createdVerts?: number[];
}

type OperatorHandler = (context: OperatorContext, params: OperatorParams) => OperatorResult;

/**
 * Reads a parameter with a fallback.
 *
 * The operator table is the scripting boundary (`app.exec("extrude", {...})`
 * can be called with anything), so every value is coerced and range-checked
 * here rather than trusted.
 */
function readNumber(params: OperatorParams, key: string, fallback: number): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function readBoolean(params: OperatorParams, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readString<T extends string>(
  params: OperatorParams,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = params[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function readVector(params: OperatorParams, key: string, fallback: Vec3): Vec3 {
  const value = params[key];
  if (typeof value !== 'object' || value === null) return fallback;
  const candidate = value as Partial<Vec3>;
  return vec3(
    typeof candidate.x === 'number' ? candidate.x : fallback.x,
    typeof candidate.y === 'number' ? candidate.y : fallback.y,
    typeof candidate.z === 'number' ? candidate.z : fallback.z,
  );
}

function selection(mesh: BMesh) {
  return {
    verts: mesh.selectedVerts(),
    edges: mesh.selectedEdges(),
    faces: mesh.selectedFaces(),
  };
}

/**
 * The kernel's operator table.
 *
 * Every mutation the UI performs goes through here, which means the test
 * harness, the undo stack and any external driver all share one surface.
 */
export const OPERATORS: Record<string, OperatorHandler> = {
  extrude: ({ mesh, selectMode }, params) => {
    const offset = readNumber(params, 'offset', 1);
    const individual = readBoolean(params, 'individual', false);
    const alongNormals = readBoolean(params, 'alongNormals', false);
    const { faces, edges } = selection(mesh);

    if (faces.length > 0) {
      const result = extrudeFaces(mesh, faces, { offset, individual, alongNormals });
      mesh.deselectAll();
      for (const face of result.faces) face.selected = true;
      mesh.flushSelection('face');
      mesh.flushSelection(selectMode);
      return { status: `Extruded ${faces.length} face(s) by ${offset}` };
    }

    if (edges.length > 0) {
      extrudeEdges(mesh, edges, vec3(0, offset, 0));
      return { status: `Extruded ${edges.length} edge(s)` };
    }

    return { status: 'Nothing selected to extrude' };
  },

  inset: ({ mesh, selectMode }, params) => {
    const faces = mesh.selectedFaces();
    if (faces.length === 0) return { status: 'Select faces to inset' };

    const result = insetFaces(mesh, faces, {
      thickness: readNumber(params, 'thickness', 0.2),
      depth: readNumber(params, 'depth', 0),
      individual: readBoolean(params, 'individual', false),
    });
    mesh.deselectAll();
    for (const face of result.faces) face.selected = true;
    mesh.flushSelection('face');
    mesh.flushSelection(selectMode);
    return { status: `Inset ${faces.length} face(s)` };
  },

  bevel: ({ mesh, selectMode }, params) => {
    const edges = mesh.selectedEdges();
    if (edges.length === 0) return { status: 'Select edges to bevel' };

    const width = readNumber(params, 'width', 0.2);
    const segments = Math.round(readNumber(params, 'segments', 1));
    const result = bevelEdges(mesh, edges, {
      width,
      segments,
      clampOverlap: readBoolean(params, 'clampOverlap', true),
    });
    mesh.flushSelection(selectMode === 'vertex' ? 'face' : selectMode);
    return { status: `Bevelled ${edges.length} edge(s) into ${result.faces.length} face(s)` };
  },

  loopCut: ({ mesh, selectMode }, params) => {
    const edges = mesh.selectedEdges();
    const start = edges[0];
    if (!start) return { status: 'Select an edge to cut across' };
    // Refused before anything is touched: the deselect below would otherwise
    // cost the user the edge they picked in exchange for a cut that never
    // happened.
    if (!canLoopCut(mesh, start)) {
      return {
        status: 'No quad ring runs across that edge: the faces beside it are triangles or n-gons',
      };
    }

    const result = loopCut(mesh, start, {
      cuts: Math.round(readNumber(params, 'cuts', 1)),
      slide: readNumber(params, 'slide', 0),
    });

    // The edge the cut ran across is still selected at this point, and its two
    // corners are corners of the box. Left in, the next transform drags them
    // along with the new loop and stretches the faces between them.
    mesh.deselectAll();
    for (const edge of result.edges) edge.selected = true;
    mesh.flushSelection('edge');
    mesh.flushSelection(selectMode);

    return { status: `Inserted ${result.verts.length} vertices` };
  },

  subdivide: ({ mesh, selectMode }, params) => {
    const cuts = Math.max(1, Math.round(readNumber(params, 'cuts', 1)));

    // In edge mode the selection is edges, so subdivide them: one vertex at
    // each edge's midpoint. Cutting the faces instead would ignore what the
    // user actually picked, and previously this just refused outright.
    if (selectMode === 'edge') {
      const edges = mesh.selectedEdges();
      if (edges.length === 0) return { status: 'Select edges to subdivide', refused: true };

      // Checked before anything is cut: a mesh past the budget cannot be
      // walked back from, because the tab it would have taken down is gone.
      const tooMany = budgetRefusal({
        verts: vertsAfterEdgeSubdivide(mesh.verts.size, edges.length, cuts),
      });
      if (tooMany) return { status: tooMany, refused: true };

      const added = subdivideEdges(mesh, edges, cuts);
      mesh.flushSelection('vertex');
      mesh.flushSelection(selectMode);
      return {
        status: `Split ${edges.length} edge(s), adding ${added.length} vertex(es)`,
        createdVerts: added.map((vert) => vert.id),
      };
    }

    const faces = mesh.selectedFaces();
    if (faces.length === 0) return { status: 'Select faces to subdivide', refused: true };

    // Costed off the plan rather than off the selection: the cuts travel, so
    // what they reach is the only honest figure to hold against the budget.
    const tooMany = budgetRefusal({ faces: subdivisionCost(mesh, faces, cuts) });
    if (tooMany) return { status: tooMany, refused: true };

    subdivideFaces(mesh, faces, { cuts, smooth: readNumber(params, 'smooth', 0) });
    // The result is expressed as selected faces, so flush from there first;
    // going straight to vertex mode would keep only the pre-existing corners.
    mesh.flushSelection('face');
    mesh.flushSelection(selectMode);
    return { status: `Subdivided ${faces.length} face(s)` };
  },

  relax: ({ mesh }, params) => {
    const verts = mesh.selectedVerts();
    if (verts.length === 0) return { status: 'Select vertices to relax', refused: true };

    const moved = relaxVerts(mesh, verts, {
      factor: readNumber(params, 'factor', 0.5),
      iterations: Math.round(readNumber(params, 'iterations', 1)),
      keepShape: readBoolean(params, 'keepShape', true),
    });
    return { status: `Relaxed ${moved} vertices` };
  },

  circle: ({ mesh }, params) => {
    const verts = mesh.selectedVerts();
    if (verts.length < 3) {
      return { status: 'Select a loop of three or more vertices', refused: true };
    }

    const moved = circleVerts(mesh, verts, { factor: readNumber(params, 'factor', 1) });
    if (moved === 0) {
      return { status: 'No loop runs through that selection to round out', refused: true };
    }
    return { status: `Rounded ${moved} vertices onto a circle` };
  },

  space: ({ mesh }, params) => {
    const verts = mesh.selectedVerts();
    if (verts.length === 0) return { status: 'Select vertices to space out', refused: true };

    const moved = spaceVerts(mesh, verts, { factor: readNumber(params, 'factor', 1) });
    if (moved === 0) {
      return { status: 'No loop runs through that selection to space along', refused: true };
    }
    return { status: `Spaced ${moved} vertices evenly` };
  },

  mergeByDistance: ({ mesh, selectMode }, params) => {
    const verts = mesh.selectedVerts();
    const target = verts.length > 0 ? verts : [...mesh.verts.values()];
    const result = mergeByDistance(mesh, target, readNumber(params, 'threshold', 0.001));
    mesh.flushSelection(selectMode);
    return { status: `Removed ${result.removed} vertices` };
  },

  merge: ({ mesh, cursor, selectMode }, params) => {
    const verts = mesh.selectedVerts();
    if (verts.length < 2) return { status: 'Select at least two vertices' };

    const mode = readString<MergeMode>(
      params,
      'mode',
      ['center', 'cursor', 'first', 'last', 'collapse'],
      'center',
    );
    const result = mergeVerts(mesh, verts, mode, cursor);
    mesh.flushSelection(selectMode);
    return { status: `Merged ${result.removed + 1} vertices at ${mode}` };
  },

  delete: ({ mesh }, params) => {
    const mode = readString(
      params,
      'mode',
      ['verts', 'edges', 'faces', 'onlyFaces', 'edgesAndFaces'] as const,
      'verts',
    );
    const before = mesh.verts.size + mesh.edges.size + mesh.faces.size;
    deleteGeometry(mesh, selection(mesh), mode);
    const removed = before - (mesh.verts.size + mesh.edges.size + mesh.faces.size);

    return { status: removed > 0 ? `Deleted ${mode}` : 'Nothing selected to delete' };
  },

  dissolve: ({ mesh }, params) => {
    const mode = readString(
      params,
      'mode',
      ['verts', 'edges', 'faces', 'limited'] as const,
      'edges',
    );
    const { verts, edges, faces } = selection(mesh);

    // Dissolving faces merges adjacent ones into a single n-gon, so one face on
    // its own has nothing to merge with: it would be torn down and rebuilt from
    // the same ring, leaving the mesh identical while reporting success.
    if (mode === 'faces' && faces.length < 2) {
      return { status: 'Select two or more adjacent faces to dissolve' };
    }

    const before = { verts: mesh.verts.size, edges: mesh.edges.size, faces: mesh.faces.size };

    // Vertex and edge dissolve both merge the faces around what they remove, so
    // both can silently fold one. They are filtered here rather than in the
    // kernel: the kernel's dissolveVerts has to merge a whole fan whatever its
    // curvature (that is what removing a vertex means), and a script calling
    // either directly keeps the unconditional behaviour.
    const limit = readNumber(params, 'angle', DISSOLVE_ANGLE_LIMIT_DEGREES);
    let skipped = 0;

    if (mode === 'verts') {
      const flat = verts.filter((vert) => isDissolvableVert(mesh, vert, limit));
      skipped = verts.length - flat.length;
      dissolveVerts(mesh, flat);
    } else if (mode === 'faces') dissolveFaces(mesh, faces);
    else if (mode === 'limited') limitedDissolve(mesh, readNumber(params, 'angle', 5));
    else {
      // Boundary edges have no second face and were never dissolvable, so they
      // are dropped quietly; only genuinely folded ones are worth reporting.
      const interior = edges.filter((edge) => mesh.edgeFaces(edge).length === 2);
      const flat = interior.filter((edge) => isDissolvableEdge(mesh, edge, limit));
      skipped = interior.length - flat.length;
      dissolveEdges(mesh, flat);
    }

    if (mode === 'faces') {
      // Two ways to end up here having changed nothing: disjoint islands that
      // each rebuild themselves, and a fully closed region (every face of a
      // cube) whose boundary ring is empty. Neither can collapse to one n-gon.
      const merged = before.faces - mesh.faces.size;
      return {
        status:
          merged > 0 ? `Dissolved ${faces.length} faces` : 'Those faces cannot merge into one',
      };
    }

    const removed =
      mode === 'verts' ? before.verts - mesh.verts.size : before.edges - mesh.edges.size;
    const noun = mode === 'verts' ? 'vertex(es)' : 'edge(s)';
    const plural = mode === 'verts' ? 'vertices' : 'edges';

    if (skipped > 0) {
      return {
        status:
          removed > 0
            ? `Dissolved ${removed} ${noun}, ${skipped} too sharp to merge`
            : `Those ${plural} join faces at too sharp an angle to merge`,
      };
    }

    return { status: removed > 0 ? `Dissolved ${removed} ${noun}` : `No ${noun} to dissolve` };
  },

  connect: ({ mesh, selectMode }) => {
    const verts = mesh.selectedVerts();
    if (verts.length !== 2) return { status: 'Select exactly two vertices to connect' };

    const result = connectVerts(mesh, verts[0], verts[1]);
    if (result.reason === 'connected') {
      return { status: 'Those vertices already share an edge' };
    }

    mesh.flushSelection(selectMode);
    return {
      status:
        result.reason === 'split' ? 'Connected, splitting the face in two' : 'Created an edge',
    };
  },

  fill: ({ mesh }, params) => {
    const edges = mesh.selectedEdges();
    if (edges.length < 3) return { status: 'Select a boundary loop to fill' };
    const created = readBoolean(params, 'bridge', false)
      ? bridgeEdgeLoops(mesh, edges)
      : fillHole(mesh, edges);
    return { status: `Created ${created.length} face(s)` };
  },

  bridge: ({ mesh }) => {
    const created = bridgeEdgeLoops(mesh, mesh.selectedEdges());
    return {
      status:
        created.length > 0 ? `Bridged into ${created.length} quads` : 'Select two equal loops',
    };
  },

  recalculateNormals: ({ mesh }, params) => {
    recalculateNormals(mesh, readBoolean(params, 'outside', true));
    return { status: 'Recalculated normals' };
  },

  flipNormals: ({ mesh }) => {
    const faces = mesh.selectedFaces();
    flipNormals(mesh, faces.length > 0 ? faces : [...mesh.faces.values()]);
    return { status: 'Flipped normals' };
  },

  shade: ({ mesh }, params) => {
    const smooth = readBoolean(params, 'smooth', true);
    const faces = mesh.selectedFaces();
    setShading(faces.length > 0 ? faces : [...mesh.faces.values()], smooth);
    return { status: smooth ? 'Shade smooth' : 'Shade flat' };
  },

  triangulate: ({ mesh }) => {
    const faces = mesh.selectedFaces();
    const created = triangulateFaces(mesh, faces.length > 0 ? faces : [...mesh.faces.values()]);
    return { status: `Triangulated into ${created.length} faces` };
  },

  trisToQuads: ({ mesh }, params) => {
    const faces = mesh.selectedFaces();
    const created = trisToQuads(
      mesh,
      faces.length > 0 ? faces : [...mesh.faces.values()],
      readNumber(params, 'angle', 40),
    );
    return { status: `Merged ${created.length} quads` };
  },

  translate: ({ mesh, proportional }, params) => {
    const verts = mesh.selectedVerts();
    translateVerts(mesh, verts, readVector(params, 'offset', vec3()), proportional);
    return { status: `Moved ${verts.length} vertices` };
  },

  rotate: ({ mesh, proportional }, params) => {
    const verts = mesh.selectedVerts();
    const axis = readString(params, 'axis', ['x', 'y', 'z'] as const, 'y');
    const angle = degToRad(readNumber(params, 'angle', 0));
    rotateVerts(mesh, verts, axisVector(axis), angle, medianPoint(verts), proportional);
    return { status: `Rotated ${verts.length} vertices` };
  },

  scale: ({ mesh, proportional }, params) => {
    const verts = mesh.selectedVerts();
    const factor = readVector(params, 'scale', vec3(1, 1, 1));
    scaleVerts(mesh, verts, factor, medianPoint(verts), proportional);
    return { status: `Scaled ${verts.length} vertices` };
  },

  shrinkFatten: ({ mesh }, params) => {
    const verts = mesh.selectedVerts();
    shrinkFatten(mesh, verts, readNumber(params, 'distance', 0.1));
    return { status: `Offset ${verts.length} vertices along normals` };
  },

  setEdgeLength: ({ mesh, objectScale }, params) => {
    const edges = mesh.selectedEdges();
    if (edges.length === 0) {
      return { status: 'Select the edge(s) to set a length for', refused: true };
    }

    // Two edges meeting at a vertex cannot both be set: the second would move a
    // vertex the first had just placed, and neither would come out the length
    // that was asked for. Refused rather than half-applied.
    if (hasConnectedEdges(edges)) {
      return {
        status: 'Two of those edges meet at a vertex: pick edge(s) that do not touch',
        refused: true,
      };
    }

    const target = readNumber(params, 'length', 1);
    if (target <= 0) return { status: 'An edge has to be longer than nothing', refused: true };

    const resized = setEdgeLengths(mesh, edges, target, objectScale ?? vec3(1, 1, 1));
    if (resized === 0) {
      return { status: 'The selected edge(s) have no length to stretch', refused: true };
    }

    return { status: `Set ${resized} edge(s) to ${target}m` };
  },

  selectAll: ({ mesh }) => {
    mesh.selectAll();
    return { status: 'Selected all' };
  },

  deselectAll: ({ mesh }) => {
    mesh.deselectAll();
    return { status: 'Deselected all' };
  },

  invertSelection: ({ mesh, selectMode }) => {
    invertSelection(mesh, selectMode);
    return { status: 'Inverted selection' };
  },

  selectFaceLoop: ({ mesh, selectMode }) => {
    const faces = mesh.selectedFaces();
    if (faces.length < 2) return { status: 'Select two adjacent faces to name a loop' };

    const loop = selectFaceLoop(mesh, faces);
    if (loop.length === 0) {
      return { status: 'No loop runs through those faces: they must be adjacent quads' };
    }

    // Added to the selection rather than replacing it: the loop already
    // contains the faces that named it, and anything else the user picked was
    // picked on purpose.
    for (const face of loop) face.selected = true;
    mesh.flushSelection('face');
    mesh.flushSelection(selectMode);

    return { status: `Selected a face loop of ${loop.length}` };
  },

  selectEdgeLoop: ({ mesh, selectMode }) => {
    const edges = mesh.selectedEdges();
    if (edges.length < 2 || !hasConnectedEdges(edges)) {
      return { status: 'Select two connected edges to name a loop' };
    }

    // Added to the selection rather than replacing it, the same as the face
    // loop: the loops already contain the edges that named them.
    const loop = selectEdgeLoops(mesh, edges);
    for (const edge of loop) edge.selected = true;
    mesh.flushSelection('edge');
    mesh.flushSelection(selectMode);

    return { status: `Selected an edge loop of ${loop.length}` };
  },

  growSelection: ({ mesh }) => {
    growSelection(mesh);
    return { status: 'Grew selection' };
  },

  shrinkSelection: ({ mesh }) => {
    shrinkSelection(mesh);
    return { status: 'Shrank selection' };
  },
};

export type OperatorName = keyof typeof OPERATORS;

/**
 * Runs a named operator. This is the surface the spec's `app.exec(...)`
 * scripting API is built on.
 */
export function execOperator(
  context: OperatorContext,
  name: string,
  params: OperatorParams = {},
): OperatorResult {
  const operator = OPERATORS[name];
  if (!operator) {
    throw new Error(
      `Unknown operator "${name}". Available: ${Object.keys(OPERATORS).sort().join(', ')}`,
    );
  }

  const result = operator(context, params);
  context.mesh.computeNormals();
  return result;
}
