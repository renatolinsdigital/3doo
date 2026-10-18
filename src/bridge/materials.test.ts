import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ShadingMode } from '@store/types';

import {
  DOT_OCCLUSION,
  VIEWPORT_COLORS,
  createDotOcclusionMaterial,
  createHoverPointMaterial,
  createNonPlanarMaterial,
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
    // By the faces round its own vertex rather than the steepest any face
    // could be, which carried a whole thin part's far side up through it.
    expect(shader.vertexShader).toContain('attribute vec4 pointFaces;');
    expect(shader.vertexShader).toContain('pointHalfSize * pointSlope * pointSpan');
    expect(shader.vertexShader.indexOf('pointLift')).toBeGreaterThan(
      shader.vertexShader.indexOf('#include <project_vertex>'),
    );
  });

  it.each([
    ['dot', createPointMaterial],
    ['hover mark', createHoverPointMaterial],
    ['fresh-vertex mark', createRecentPointMaterial],
  ])('settles whether the %s is drawn at its own vertex, before the lift', (_, create) => {
    // A lift is pixels of depth, and zoomed out that is deeper than another
    // object a few millimetres in front: its vertices came up through it.
    const material = create();
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.points.uniforms),
      vertexShader: THREE.ShaderLib.points.vertexShader,
      fragmentShader: THREE.ShaderLib.points.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;

    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

    // The very objects the viewport fills each frame, shared by every mark.
    expect(shader.uniforms.dotOcclusionActive).toBe(DOT_OCCLUSION.dotOcclusionActive);
    expect(shader.uniforms.dotOcclusionMap).toBe(DOT_OCCLUSION.dotOcclusionMap);
    expect(shader.uniforms.dotOcclusionSize).toBe(DOT_OCCLUSION.dotOcclusionSize);

    const test = shader.vertexShader.indexOf('dotOccluded( gl_Position, pointSpan )');
    expect(test).toBeGreaterThan(shader.vertexShader.indexOf('#include <project_vertex>'));
    expect(test).toBeLessThan(shader.vertexShader.indexOf('float pointLift'));
  });

  it('hides a dot only behind a face that reaches its vertex', () => {
    // A far-side vertex a fraction of a pixel inside a contour has background
    // in one of the four pixels round it, and that pixel alone used to draw it:
    // half a dot beside the contour's own vertex.
    const material = createPointMaterial();
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.points.uniforms),
      vertexShader: THREE.ShaderLib.points.vertexShader,
      fragmentShader: THREE.ShaderLib.points.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;

    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

    const test = shader.vertexShader;
    const empty = test.indexOf('if ( ( surface.a & 524288u ) == 0u ) continue;');
    expect(empty).toBeGreaterThan(0);
    // Another object in front hides it where its face's nearest point is in
    // front too; of its own faces, the edges nearest the pixel are asked about
    // the spot.
    expect(test).toContain('if ( ( surface.a & 1048576u ) == 0u ) {');
    expect(test).toContain('if ( aheadAtEdge > margin ) return true;');
    expect(test).toContain('if ( dotEdgeReach( edges[ k ], offset ) <= ');
    expect(test.indexOf('if ( reaches ) return true;')).toBeGreaterThan(empty);
  });

  it('is left to the depth test outside the viewport frame that fills it', () => {
    expect(DOT_OCCLUSION.dotOcclusionActive.value).toBe(false);
  });

  it('holds a texture its unsigned integer sampler can read when no pass has filled it', () => {
    // The map used to be null there, and three binds a float texture in its
    // place. WebGL2 refuses a draw whose usampler2D meets a float texture, so
    // every wire drawn outside the viewport's own frame was thrown away: the
    // MCP's pictures came out with no wireframe in solidWire or wireframe.
    expect(DOT_OCCLUSION.dotOcclusionMap.value).toMatchObject({
      format: THREE.RGBAIntegerFormat,
      type: THREE.UnsignedIntType,
      internalFormat: 'RGBA32UI',
    });
  });
});

describe('dot occlusion material', () => {
  it('paints the depth of each surface with its slope across the screen', () => {
    // The slope is what carries a pixel's surface to the vertex's own spot,
    // where the faces through the vertex meet it exactly.
    const material = createDotOcclusionMaterial();
    expect(material.fragmentShader).toContain('dFdx( depth ), dFdy( depth )');
  });

  it('leaves the faces where they are, with no offset to sink them', () => {
    expect(createDotOcclusionMaterial().polygonOffset).toBe(false);
  });

  it("paints the face's own edges, past the diagonals it was cut along", () => {
    // Depth and slope say how deep a face would be at a vertex, not whether the
    // face gets that far, and a quad's diagonal is no end to it: the sides out
    // to the far corner across it are.
    const material = createDotOcclusionMaterial();

    expect(material.vertexShader).toContain('attribute float triangleCorner;');
    expect(material.vertexShader).toContain('attribute vec3 farCornerA;');
    expect(material.fragmentShader).toContain('keepEdgeThrough( first, farAt, second );');
    expect(material.fragmentShader).toContain('keepEdgeThrough( farAt, second, first );');
    expect(material.uniforms.size.value).toBeInstanceOf(THREE.Vector2);
  });

  it('packs all of it into four words a pixel, the size four floats took', () => {
    const material = createDotOcclusionMaterial();

    expect(material.glslVersion).toBe(THREE.GLSL3);
    expect(material.fragmentShader).toContain('out highp uvec4 occlusion;');
  });

  it("marks which pixels are the dots' own object's, object by object", () => {
    // Another object in front needs no more asking than that it is there; the
    // faces round a vertex need their sides asked.
    const material = createDotOcclusionMaterial();
    const own = new THREE.Mesh();
    own.userData.ownsDots = true;
    const draw = (object: THREE.Object3D) =>
      material.onBeforeRender(
        {} as THREE.WebGLRenderer,
        new THREE.Scene(),
        new THREE.Camera(),
        new THREE.BufferGeometry(),
        object,
        new THREE.Group(),
      );

    draw(own);
    expect(material.uniforms.ownsDots.value).toBe(true);
    expect(material.uniformsNeedUpdate).toBe(true);

    draw(new THREE.Mesh());
    expect(material.uniforms.ownsDots.value).toBe(false);
  });

  it('marks which object each pixel is, for the wire to tell its own surface from another', () => {
    const material = createDotOcclusionMaterial();
    const tagged = new THREE.Mesh();
    tagged.userData.surfaceTag = 7;
    const draw = (object: THREE.Object3D) =>
      material.onBeforeRender(
        {} as THREE.WebGLRenderer,
        new THREE.Scene(),
        new THREE.Camera(),
        new THREE.BufferGeometry(),
        object,
        new THREE.Group(),
      );

    draw(tagged);
    expect(material.uniforms.surfaceTag.value).toBe(7);
    expect(material.fragmentShader).toContain('uint( surfaceTag ) << 21');

    // Zero is no view's tag, so a surface without one is never a wire's own.
    draw(new THREE.Mesh());
    expect(material.uniforms.surfaceTag.value).toBe(0);
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
    expect(wire.vertexShader).toContain('startLift');
    expect(wire.polygonOffset).toBe(false);
  });

  it('sizes the lift by the faces either side of the edge, not by the steepest there is', () => {
    // A fixed lift sized for a face at 83 degrees carried far-side edges
    // through a cylinder's cap as ticks along the rim. Each edge carries its
    // own two face normals now, and the lift is what those need.
    const shader = createWireMaterial(false).vertexShader;

    expect(shader).toContain('attribute vec3 instanceSideA');
    expect(shader).toContain('attribute vec3 instanceSideB');
    expect(shader).toContain('wireSlope( start.xyz )');
  });

  it('lifts the modifier preview the same way, its lines lying on a surface too', () => {
    expect(createPreviewWireMaterial().vertexShader).toContain('startLift');
  });

  it('takes the lift off the view ray, so an edge does not slide across the screen', () => {
    // Under perspective the ends move towards the camera along the ray they
    // are seen on, which is all three components scaled. Dropping the depth on
    // its own moves the projected point as well.
    expect(createWireMaterial(false).vertexShader).toContain('start.xyz *= 1.0 - startLift');
  });

  it('writes no depth, so the marks drawn after it still come through', () => {
    // It sits a slope ahead of the surface: writing depth there would hide the
    // vertex-mode fade and the normals, which run along the same edges.
    expect(createWireMaterial(false).depthWrite).toBe(false);
  });

  it.each([
    ['plain wire', () => createWireMaterial(false)],
    ['selected edges', () => createWireMaterial(true)],
    ['modifier preview', createPreviewWireMaterial],
  ])("tests the %s against other objects' surfaces where it lies before the lift", (_, create) => {
    // The lift is owed to the wire's own surface. Zoomed out, it carried the
    // edges of a part a few millimetres inside another across the outer one.
    const wire = create();

    expect(wire.uniforms.dotOcclusionActive).toBe(DOT_OCCLUSION.dotOcclusionActive);
    expect(wire.uniforms.dotOcclusionMap).toBe(DOT_OCCLUSION.dotOcclusionMap);
    expect(wire.uniforms.surfaceTag.value).toBe(0);

    const saved = wire.vertexShader.indexOf('vec4 wireStart = start;');
    expect(saved).toBeGreaterThan(0);
    expect(saved).toBeLessThan(wire.vertexShader.indexOf('start.xyz *= 1.0 - startLift'));
    expect(wire.vertexShader).toContain('vWireStart = wireOnMap( projectionMatrix * wireStart );');

    expect(wire.fragmentShader).toContain(
      'if ( surface.a >> 21 == uint( surfaceTag ) ) return false;',
    );
    expect(wire.fragmentShader).toContain('if ( wireOccluded() ) discard;');
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

  it("tests the wash against other objects' surfaces, its offset left out", () => {
    // The offset's slope term washed another object red where one stood just
    // in front of the faces picked.
    const material = createSelectionOverlayMaterial();
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms),
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;

    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

    expect(shader.uniforms.dotOcclusionActive).toBe(DOT_OCCLUSION.dotOcclusionActive);
    expect(shader.uniforms.surfaceTag).toBe(material.userData.surfaceTag);
    expect(shader.vertexShader).toContain('vMarkClip = gl_Position;');
    expect(shader.fragmentShader).toContain('if ( markOccluded(');
  });
});

describe('non-planar overlay', () => {
  it('is an amber wash drawn the way the selection one is', () => {
    const wash = createNonPlanarMaterial() as THREE.MeshBasicMaterial;
    const selection = createSelectionOverlayMaterial() as THREE.MeshBasicMaterial;

    expect(wash.color.getHex()).toBe(VIEWPORT_COLORS.amber);
    for (const key of [
      'depthTest',
      'depthWrite',
      'transparent',
      'polygonOffsetFactor',
      'polygonOffsetUnits',
    ] as const) {
      expect(wash[key]).toBe(selection[key]);
    }
    expect(wash.userData.surfaceTag).toEqual({ value: 0 });
  });
});
