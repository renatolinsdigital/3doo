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
   * Every mark on a mesh is built from the same vertices as the fill, so a few
   * units of depth are what break the tie between them. One unit left them
   * fading in and out as a mesh deformed.
   */
  it.each(['solid', 'solidWire', 'matcap'] as const)(
    'breaks the %s fill out of its depth tie with the marks on it',
    (shading) => {
      const material = surface(shading);

      expect(material.polygonOffset).toBe(true);
      expect(material.polygonOffsetUnits).toBeGreaterThanOrEqual(4);
    },
  );

  /**
   * The slope-scaled term grows with how steeply a polygon is turned away, so
   * on a face seen edge-on it sank the fill far enough for the far side of the
   * model to climb through, as a second line beside the near one and as a band
   * of back-face shading along the contour.
   */
  it.each(['solid', 'solidWire', 'matcap'] as const)(
    'sinks the %s fill by a constant, never by its slope',
    (shading) => {
      expect(surface(shading).polygonOffsetFactor).toBe(0);
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
    // The line lies exactly on the silhouette, which is where a fill's depth
    // swings fastest across a pixel, so it rises towards the camera by that
    // same slope rather than trusting the constant the fill is sunk by.
    const outline = createOutlineMaterial({ color: 0xe5342a, width: 2 });

    expect(outline.polygonOffset).toBe(true);
    expect(outline.polygonOffsetFactor).toBeLessThanOrEqual(-1);
    expect(surface('solid').polygonOffsetUnits).toBeGreaterThan(0);
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

  it('rises off the surface by its slope, which a plain line cannot ask for', () => {
    // The whole reason the wire is drawn as quads. WebGL offsets polygons and
    // nothing else, and without this the fill ate the last pixels of an edge
    // wherever it ran into a junction between faces seen nearly edge-on.
    const wire = createWireMaterial(false);

    expect(wire.polygonOffset).toBe(true);
    expect(wire.polygonOffsetFactor).toBeLessThanOrEqual(-1);
  });

  it('writes no depth, so the marks drawn after it still come through', () => {
    // It sits a slope ahead of the surface: writing depth there would hide the
    // vertex-mode fade and the normals, which run along the same edges.
    expect(createWireMaterial(false).depthWrite).toBe(false);
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
    expect(surface('solid').polygonOffsetUnits).toBeGreaterThan(0);
  });
});
