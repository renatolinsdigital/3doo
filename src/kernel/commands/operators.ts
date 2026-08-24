import { type Vec3, axisVector, degToRad, vec3 } from '../math';
import type { BMesh } from '../mesh';
import type { SelectMode } from '../mesh/types';
import {
  type FalloffCurve,
  type MergeMode,
  DISSOLVE_ANGLE_LIMIT_DEGREES,
  bevelEdges,
  bridgeEdgeLoops,
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
  insetFaces,
  invertSelection,
  isDissolvableEdge,
  limitedDissolve,
  loopCut,
  medianPoint,
  mergeByDistance,
  mergeVerts,
  recalculateNormals,
  rotateVerts,
  scaleVerts,
  setShading,
  shrinkFatten,
  shrinkSelection,
  subdivideFaces,
  translateVerts,
  triangulateFaces,
  trisToQuads,
} from '../ops';

export interface OperatorContext {
  mesh: BMesh;
  selectMode: SelectMode;
  cursor: Vec3;
  proportional?: { enabled: boolean; radius: number; falloff: FalloffCurve };
}

export type OperatorParams = Record<string, unknown>;

export interface OperatorResult {
  /** Short human-readable summary shown in the status bar. */
  status: string;
}

type OperatorHandler = (context: OperatorContext, params: OperatorParams) => OperatorResult;

/**
 * Reads a parameter with a fallback.
 *
 * The operator table is the scripting boundary — `app.exec("extrude", {...})`
 * can be called with anything — so every value is coerced and range-checked
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

  loopCut: ({ mesh }, params) => {
    const edges = mesh.selectedEdges();
    const start = edges[0];
    if (!start) return { status: 'Select an edge to cut across' };

    const result = loopCut(mesh, start, {
      cuts: Math.round(readNumber(params, 'cuts', 1)),
      slide: readNumber(params, 'slide', 0),
    });
    return { status: `Inserted ${result.verts.length} vertices` };
  },

  subdivide: ({ mesh, selectMode }, params) => {
    const faces = mesh.selectedFaces();
    if (faces.length === 0) return { status: 'Select faces to subdivide' };

    subdivideFaces(mesh, faces, {
      cuts: Math.round(readNumber(params, 'cuts', 1)),
      smooth: readNumber(params, 'smooth', 0),
    });
    // The result is expressed as selected faces, so flush from there first;
    // going straight to vertex mode would keep only the pre-existing corners.
    mesh.flushSelection('face');
    mesh.flushSelection(selectMode);
    return { status: `Subdivided ${faces.length} face(s)` };
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
    const mode = readString(params, 'mode', ['verts', 'edges', 'faces', 'limited'] as const, 'edges');
    const { verts, edges, faces } = selection(mesh);

    // Dissolving faces merges adjacent ones into a single n-gon, so one face on
    // its own has nothing to merge with: it would be torn down and rebuilt from
    // the same ring, leaving the mesh identical while reporting success.
    if (mode === 'faces' && faces.length < 2) {
      return { status: 'Select two or more adjacent faces to dissolve' };
    }

    const before = { verts: mesh.verts.size, edges: mesh.edges.size, faces: mesh.faces.size };

    // Edge dissolve is the one path that can silently fold a face, so the
    // too-sharp edges are filtered here rather than in the kernel: vertex
    // dissolve still has to merge a whole fan whatever its curvature, and a
    // script calling dissolveEdges directly keeps the unconditional behaviour.
    let skipped = 0;
    if (mode === 'verts') dissolveVerts(mesh, verts);
    else if (mode === 'faces') dissolveFaces(mesh, faces);
    else if (mode === 'limited') limitedDissolve(mesh, readNumber(params, 'angle', 5));
    else {
      const limit = readNumber(params, 'angle', DISSOLVE_ANGLE_LIMIT_DEGREES);
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

    if (skipped > 0) {
      return {
        status:
          removed > 0
            ? `Dissolved ${removed} edge(s), ${skipped} too sharp to merge`
            : 'Those edges join faces at too sharp an angle to merge',
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
    return { status: created.length > 0 ? `Bridged into ${created.length} quads` : 'Select two equal loops' };
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
