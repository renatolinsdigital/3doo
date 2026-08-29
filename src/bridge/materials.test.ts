import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ShadingMode } from '@store/types';

import {
  createOutlineMaterial,
  createPointMaterial,
  createRecentPointMaterial,
  createSelectionOverlayMaterial,
  createSurfaceMaterial,
  createWireMaterial,
} from './materials';

function surface(shading: ShadingMode): THREE.Material {
  return createSurfaceMaterial({ color: 0xcccccc, shading, backfaceCulling: true });
}

beforeAll(() => {
  // The matcap paints its texture on a 2D canvas, which jsdom does not have.
  // Returning null is the path the painter already handles; letting jsdom
  // refuse it works too, but writes a stack trace into every run.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

describe('surface stencil stamp', () => {
  it('stamps the mask the outline keeps off, in every shading that draws a fill', () => {
    for (const shading of ['solid', 'solidWire', 'matcap', 'xray'] as const) {
      const material = surface(shading);
      expect(material.stencilFunc).toBe(THREE.AlwaysStencilFunc);
      expect(material.stencilZPass).toBe(THREE.ReplaceStencilOp);
    }
  });

  it('stamps nothing until something asks, so an unselected fill costs no state', () => {
    expect(surface('solid').stencilWrite).toBe(false);
  });
});

describe('surface depth offset', () => {
  /**
   * The wireframe is built from the same vertices as the fill, so nothing but
   * this offset keeps an edge in front of the face it runs along. One unit of
   * it left edges fading in and out as a mesh deformed.
   */
  it.each(['solid', 'solidWire', 'matcap'] as const)(
    'sinks the %s fill well clear of the wireframe on it',
    (shading) => {
      const material = surface(shading);

      expect(material.polygonOffset).toBe(true);
      expect(material.polygonOffsetFactor).toBeGreaterThanOrEqual(4);
      expect(material.polygonOffsetUnits).toBeGreaterThanOrEqual(4);
    },
  );

  it('leaves the x-ray fill flat, having no depth for a line to fight over', () => {
    expect(surface('xray').depthWrite).toBe(false);
  });
});

describe('vertex point material', () => {
  it('depth-tests the dots, so vertices behind a solid surface stay hidden', () => {
    expect(createPointMaterial().depthTest).toBe(true);
  });

  it('depth-tests the marks on freshly made vertices for the same reason', () => {
    expect(createRecentPointMaterial().depthTest).toBe(true);
  });
});

describe('selection outline material', () => {
  it('depth-tests, so an object never wears its own far silhouette', () => {
    expect(createOutlineMaterial({ color: 0xe5342a, width: 2 }).depthTest).toBe(true);
  });

  it('refuses the pixels the object itself covers', () => {
    // What makes it a contour rather than every silhouette edge the object has:
    // the fold inside a cut is front face against back face, exactly like the
    // outer edge, and only the fill in the way tells the two apart.
    const outline = createOutlineMaterial({ color: 0xe5342a, width: 2 });

    expect(outline.stencilWrite).toBe(true);
    expect(outline.stencilFunc).toBe(THREE.NotEqualStencilFunc);
    expect(outline.stencilRef).toBe(surface('solid').stencilRef);
  });

  it('leaves the stencil as it found it', () => {
    // The outline reads the mask; stamping it as well would have one selected
    // object's line cut into the next one's.
    const outline = createOutlineMaterial({ color: 0xe5342a, width: 2 });

    expect(outline.stencilFail).toBe(THREE.KeepStencilOp);
    expect(outline.stencilZFail).toBe(THREE.KeepStencilOp);
    expect(outline.stencilZPass).toBe(THREE.KeepStencilOp);
  });

  it('lifts the line clear of the surface it traces', () => {
    // Both halves of the same bargain: the fill sinks away from the camera and
    // the outline rises towards it. The line lies exactly on the silhouette,
    // which is where a fill's depth swings fastest, so one offset alone left
    // the surface eating the inner half of its own outline.
    const outline = createOutlineMaterial({ color: 0xe5342a, width: 2 });

    expect(outline.polygonOffset).toBe(true);
    expect(outline.polygonOffsetFactor).toBeLessThanOrEqual(-1);
    expect(surface('solid').polygonOffsetFactor).toBeGreaterThanOrEqual(4);
  });
});

describe('wireframe material', () => {
  it('depth-tests the plain wireframe, so edges round the back stay hidden', () => {
    expect(createWireMaterial(false).depthTest).toBe(true);
  });

  it('depth-tests the selected edges too, opaque shading having no way through', () => {
    // Drawn over everything, a selection round the back of a solid model reads
    // as running across the face in front of it. X-ray and wireframe still show
    // it: neither leaves any depth for this to test against.
    expect(createWireMaterial(true).depthTest).toBe(true);
  });
});

describe('selected face overlay', () => {
  it('stays behind an opaque surface, rather than washing the face in front', () => {
    expect(createSelectionOverlayMaterial().depthTest).toBe(true);
  });

  it('writes no depth, so the selected edges and dots come through it', () => {
    expect(createSelectionOverlayMaterial().depthWrite).toBe(false);
  });

  it('lifts off the faces it marks, against the offset sinking the fill', () => {
    const overlay = createSelectionOverlayMaterial();

    expect(overlay.polygonOffset).toBe(true);
    expect(overlay.polygonOffsetFactor).toBeLessThanOrEqual(-1);
    expect(surface('solid').polygonOffsetFactor).toBeGreaterThanOrEqual(4);
  });
});
