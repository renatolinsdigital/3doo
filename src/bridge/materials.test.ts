import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ShadingMode } from '@store/types';

import {
  createHoverPointMaterial,
  createOutlineMaterial,
  createPointMaterial,
  createPreviewWireMaterial,
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

describe('imported image surface', () => {
  const texture = () => new THREE.Texture();

  it('draws the picture unlit, from both sides', () => {
    const map = texture();
    const material = createSurfaceMaterial({
      color: 0xcccccc,
      shading: 'solid',
      backfaceCulling: true,
      map,
    });

    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((material as THREE.MeshBasicMaterial).map).toBe(map);
    // White, so the picture is the colour: tinting it by the material slot
    // would be lying about the image.
    expect((material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xffffff);
    expect(material.side).toBe(THREE.DoubleSide);
  });

  // The picture is the whole of what an image object is for, and a plane has no
  // shape to read instead, so nothing the shading menu offers applies to it.
  it.each(['solid', 'solidWire', 'wireframe', 'xray', 'matcap'] as const)(
    'keeps the picture under %s shading',
    (shading) => {
      const map = texture();
      const material = createSurfaceMaterial({
        color: 0xcccccc,
        shading,
        backfaceCulling: true,
        map,
      });

      expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect((material as THREE.MeshBasicMaterial).map).toBe(map);
      expect(material.transparent).toBe(false);
    },
  );
});

describe('vertex point material', () => {
  it('depth-tests the dots, so vertices behind a solid surface stay hidden', () => {
    expect(createPointMaterial().depthTest).toBe(true);
  });

  it('depth-tests the marks on freshly made vertices for the same reason', () => {
    expect(createRecentPointMaterial().depthTest).toBe(true);
  });

  it.each([
    ['dot', createPointMaterial],
    ['hover mark', createHoverPointMaterial],
    ['fresh-vertex mark', createRecentPointMaterial],
  ])('lifts the %s off the surface by half its own size', (_, create) => {
    // A point is one depth across its whole square, so without the lift the
    // half of it over a face leaning towards the camera loses the depth test.
    const material = create();
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.points.uniforms),
      vertexShader: THREE.ShaderLib.points.vertexShader,
      fragmentShader: THREE.ShaderLib.points.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;

    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

    expect(shader.uniforms.pointHalfSize.value).toBe(material.size / 2);
    expect(shader.vertexShader).toContain('uniform float pointHalfSize;');
    expect(shader.vertexShader).toContain('mvPosition.xyz *= 1.0 - pointLift');
    expect(shader.vertexShader.indexOf('pointLift')).toBeGreaterThan(
      shader.vertexShader.indexOf('#include <project_vertex>'),
    );
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

  it('floats towards the camera in the vertex shader, whatever way the edge runs', () => {
    // The whole reason the wire is drawn as quads. Polygon offset scales its
    // slope term by the quad's own gradient, and a wire quad has none across
    // its width, so an edge lying across a face seen at an angle lost half its
    // width to the fill while an edge receding from the camera kept all of it.
    const wire = createWireMaterial(false);
    const stock = new LineMaterial();

    expect(wire.vertexShader).not.toBe(stock.vertexShader);
    expect(wire.vertexShader).toContain('wireLift');
    expect(wire.polygonOffset).toBe(false);
  });

  it('lifts the modifier preview the same way, its lines lying on a surface too', () => {
    expect(createPreviewWireMaterial().vertexShader).toContain('wireLift');
  });

  it('takes the lift off the view ray, so an edge does not slide across the screen', () => {
    // Under perspective the ends move towards the camera along the ray they
    // are seen on, which is all three components scaled. Dropping the depth on
    // its own moves the projected point as well.
    expect(createWireMaterial(false).vertexShader).toContain('start.xyz *= 1.0 - wireLift');
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
