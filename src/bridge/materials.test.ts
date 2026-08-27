import type * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ShadingMode } from '@store/types';

import { createPointMaterial, createSurfaceMaterial, createWireMaterial } from './materials';

function surface(shading: ShadingMode): THREE.Material {
  return createSurfaceMaterial({ color: 0xcccccc, shading, backfaceCulling: true });
}

beforeAll(() => {
  // The matcap paints its texture on a 2D canvas, which jsdom does not have.
  // Returning null is the path the painter already handles; letting jsdom
  // refuse it works too, but writes a stack trace into every run.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
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
});

describe('wireframe material', () => {
  it('depth-tests the plain wireframe, so edges round the back stay hidden', () => {
    expect(createWireMaterial(false).depthTest).toBe(true);
  });

  it('draws selected edges over everything, since those are the answer to a click', () => {
    expect(createWireMaterial(true).depthTest).toBe(false);
  });
});
