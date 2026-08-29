/**
 * What one mesh may grow to inside a browser tab.
 *
 * A BMesh is a graph of objects (a vertex, an edge, a loop per corner) and
 * measures about 2.5 kB a face, so a quarter of a million faces is some 600 MB
 * of heap before the viewport has drawn any of it, on top of a second or so to
 * rebuild the buffers it draws from. Past that a tab does not get slower, it
 * dies: a subdivision that took a mesh of 140,000 faces to three and a half
 * million took the window with it.
 *
 * Operations that multiply geometry work out what they would leave and check it
 * here before they start, because nothing can stop them once they have.
 */
export const MESH_BUDGET = { faces: 250_000, verts: 250_000 } as const;

/**
 * Where an operation stops being instant.
 *
 * Nothing is refused at this size: it is the point at which the user is told
 * an operation will take a moment before it takes it.
 */
export const MESH_WARNING = { faces: 60_000, verts: 60_000 } as const;

/** What an operation would leave the mesh holding, in whichever count grows. */
export interface Growth {
  faces?: number;
  verts?: number;
}

function readable(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** Why a result this size is refused, or null when it fits. */
export function budgetRefusal(growth: Growth): string | null {
  if (growth.faces !== undefined && growth.faces > MESH_BUDGET.faces) {
    return `That would leave ${readable(growth.faces)} faces, past the ${readable(MESH_BUDGET.faces)} a browser tab can hold. Use fewer cuts, or select fewer faces.`;
  }
  if (growth.verts !== undefined && growth.verts > MESH_BUDGET.verts) {
    return `That would leave ${readable(growth.verts)} vertices, past the ${readable(MESH_BUDGET.verts)} a browser tab can hold. Use fewer cuts, or select fewer edges.`;
  }
  return null;
}

/** Whether a result this size is worth warning about before running it. */
export function worthWarning(growth: Growth): boolean {
  return (
    (growth.faces !== undefined && growth.faces > MESH_WARNING.faces) ||
    (growth.verts !== undefined && growth.verts > MESH_WARNING.verts)
  );
}

/** Vertices an edge subdivision would leave behind: one per cut, per edge. */
export function vertsAfterEdgeSubdivide(verts: number, edges: number, cuts: number): number {
  return verts + edges * cuts;
}
