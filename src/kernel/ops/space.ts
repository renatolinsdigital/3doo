import { clamp, lerp } from '../math';
import type { BMesh } from '../mesh';
import type { Vert } from '../mesh/types';

import { chainPath, findChains, isClosedChain, spreadAlong } from './chains';

export interface SpaceOptions {
  /** 0..1 blend from where a vertex sits toward its even share of the loop. */
  factor?: number;
}

/**
 * Evens out the spacing of the selected vertices along the loop they lie on.
 *
 * The half of relax that only moves vertices along the line they already
 * describe: the loop keeps every bend it has, and the vertices slide along it
 * until the gaps between them are equal. That is what makes it the operator to
 * reach for on a loop whose shape is right and whose spacing is not, where a
 * relax would round off the corners as it went.
 *
 * A loop that closes on itself is spaced right round; one that stops is spaced
 * between the two vertices it stopped at, which hold still so the loop stays
 * joined to the rest of the mesh. Vertices with no loop through them have
 * nothing to be spaced along and are left alone.
 *
 * Returns how many vertices were moved.
 */
export function spaceVerts(
  mesh: BMesh,
  verts: readonly Vert[],
  options: SpaceOptions = {},
): number {
  const factor = clamp(options.factor ?? 1, 0, 1);
  if (factor === 0) return 0;

  const { chains } = findChains(mesh, verts);
  let moved = 0;

  for (const chain of chains) {
    // Every target is worked out before any vertex moves: spacing against a
    // path that was already half respaced would drag the later vertices of the
    // loop toward the earlier ones.
    const path = chainPath(chain);
    const targets = spreadAlong(path, isClosedChain(chain), chain.verts.length);

    chain.verts.forEach((vert, i) => {
      vert.co = lerp(vert.co, targets[i], factor);
    });
    moved += chain.verts.length;
  }

  if (moved > 0) mesh.computeNormals();
  return moved;
}
