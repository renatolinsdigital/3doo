import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

import type { ShadingMode } from '@store/types';

/** Design tokens the viewport needs in numeric form. */
export const VIEWPORT_COLORS = {
  void: 0x0b0b0b,
  bone: 0xf4f1ea,
  red: 0xe5342a,
  oxblood: 0x7b1113,
  rust: 0xb8452f,
  ash: 0x1a1918,
  grid: 0x3a2a28,
  amber: 0xf2a03d,
  cyan: 0x3de0d0,
} as const;

/**
 * One colour per axis, shared by the world centre lines and the gizmo handles.
 *
 * Blender's scheme with this palette's hues standing in for raw RGB: X keeps
 * red, Y takes amber where Blender uses green, Z takes cyan where it uses blue.
 * Both the grid and the gizmo read this table, so an axis is the same colour
 * wherever it shows up.
 */
export const AXIS_COLORS = {
  x: VIEWPORT_COLORS.red,
  y: VIEWPORT_COLORS.amber,
  z: VIEWPORT_COLORS.cyan,
} as const;

/**
 * Procedural matcap.
 *
 * A generated radial ramp avoids shipping a texture asset while still giving
 * the flat, high-contrast shading the brutalist direction asks for.
 */
function createMatcapTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(
      size * 0.35,
      size * 0.3,
      size * 0.05,
      size * 0.5,
      size * 0.5,
      size * 0.6,
    );
    gradient.addColorStop(0, '#f4f1ea');
    gradient.addColorStop(0.45, '#b8b3a6');
    gradient.addColorStop(0.8, '#5c574e');
    gradient.addColorStop(1, '#26231f');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let matcapTexture: THREE.Texture | null = null;

function getMatcap(): THREE.Texture {
  matcapTexture ??= createMatcapTexture();
  return matcapTexture;
}

/**
 * Breaks the depth tie between the shaded surface and the marks drawn on it.
 *
 * Every mark the viewport puts on a mesh is built from the same vertices as the
 * fill under it, so the two come out of the rasteriser at the same depth and
 * which one survives comes down to float rounding: a mark shows on one face,
 * stipples on the next, and changes again as the mesh deforms under it. A few
 * units of the depth buffer's own resolution settle that, and they stay a
 * vanishingly small distance at any zoom.
 *
 * Constant only, with no slope-scaled term. The slope term grows with how
 * steeply a polygon is turned away from the camera, so on a face seen nearly
 * edge-on, which is every silhouette and every tight corner, it sank the fill
 * far enough for the geometry behind it to climb through: edges from the far
 * side drew as a second line beside the near one, and the back face won a band
 * of pixels along the contour and painted it in its own shading. What a line
 * needs at those angles is a lift of its own, and that now lives on the line
 * (see `liftWire`) instead of being paid for by sinking everything else.
 */
const SURFACE_DEPTH_OFFSET = {
  polygonOffset: true,
  polygonOffsetFactor: 0,
  polygonOffsetUnits: 4,
} as const;

/**
 * The steepest a surface may be turned away from the camera and still have the
 * wire crossing it drawn whole, as a slope. Eight is a face at about 83
 * degrees.
 *
 * Past that a face is edge-on enough to be a contour, and what runs across it
 * is a pixel or two of a surface nobody can read anyway.
 */
const WIRE_LIFT_SLOPE = 8;

/** Where the lift is spliced into `LineMaterial`'s vertex shader. */
const WIRE_LIFT_ANCHOR = 'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );';

const WIRE_LIFT_GLSL = /* glsl */ `
			// A pixel's width in view units: per unit of depth under perspective,
			// outright under an orthographic camera, which is what lets one
			// expression serve both.
			float wireSpan = 2.0 / ( resolution.y * projectionMatrix[ 1 ][ 1 ] );
			float wireLift = 0.5 * linewidth * ${WIRE_LIFT_SLOPE.toFixed(1)} * wireSpan;

			if ( projectionMatrix[ 2 ][ 3 ] == - 1.0 ) {

				// Along the view ray, by scaling all three components. Taking it
				// off the depth alone would slide the line across the screen, by
				// a pixel and more out towards the corners.
				start.xyz *= 1.0 - wireLift;
				end.xyz *= 1.0 - wireLift;

			} else {

				start.z += wireLift;
				end.z += wireLift;

			}
`;

/**
 * Floats a wire towards the camera by what the surface under it gains in depth
 * across half the line's own width.
 *
 * Polygon offset cannot do this job, which is why it no longer tries. Its
 * slope term is scaled by the polygon's own steepest depth gradient, and a
 * wire quad is flat across its width: all four corners take the depth of the
 * edge they stand on, so the only gradient it has runs along the line. An edge
 * receding from the camera was lifted hard by that and drew whole, while an
 * edge lying across the same face got almost nothing, though the surface
 * beside it climbs just as fast. Half of that second wire, the half on the
 * side where the surface comes forward, lost the depth test and was never
 * drawn: measured off a screenshot of a subdivided cylinder, those edges
 * carried 0.34 of a pixel of ink against 0.74 for the ones running away from
 * the camera. Which edges went faint changed as the camera moved, since what
 * decides it is the angle a face is seen at.
 *
 * So the lift owes nothing to the line's own direction, and a quad is what
 * lets it: the width is already the vertex shader's to choose, and this puts
 * the depth there too.
 */
function liftWire<T extends LineMaterial>(material: T): T {
  material.vertexShader = material.vertexShader.replace(
    WIRE_LIFT_ANCHOR,
    WIRE_LIFT_ANCHOR + WIRE_LIFT_GLSL,
  );
  return material;
}

/**
 * The stencil value a selected object's fill stamps on the pixels it covers.
 *
 * The outline refuses those pixels, which is the whole of how it comes out as
 * the object's contour rather than as every silhouette edge it owns. Nothing
 * local to an edge separates the two: the fold inside a cut has a front face on
 * one side and a back face on the other, exactly like the outer edge does. What
 * tells them apart is whether the object's own surface is in the way, and the
 * pixels it covered is the cheapest true answer to that.
 */
const OUTLINE_STENCIL = 1;

/** Stamps `OUTLINE_STENCIL`, once `stencilWrite` is switched on. */
const OUTLINE_STENCIL_STAMP = {
  stencilRef: OUTLINE_STENCIL,
  stencilFunc: THREE.AlwaysStencilFunc,
  stencilZPass: THREE.ReplaceStencilOp,
} as const;

export interface SurfaceMaterialOptions {
  color: THREE.ColorRepresentation;
  shading: ShadingMode;
  backfaceCulling: boolean;
  /** An imported image drawn on the surface, for an image plane. */
  map?: THREE.Texture | null;
}

export function createSurfaceMaterial({
  color,
  shading,
  backfaceCulling,
  map = null,
}: SurfaceMaterialOptions): THREE.Material {
  const side = backfaceCulling ? THREE.FrontSide : THREE.DoubleSide;

  // An imported picture is drawn unlit and from both sides: it is a reference
  // to model against, and one that dims as the scene's light swings past it,
  // or disappears when the plane is turned round, has stopped telling the truth
  // about the image. The shading mode never reaches it: a plane wearing a
  // picture has no shape worth reading, so x-ray and wireframe would trade the
  // one thing it is there for against four edges (see `ObjectView.update`).
  if (map) {
    return new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map,
      side: THREE.DoubleSide,
      ...SURFACE_DEPTH_OFFSET,
      ...OUTLINE_STENCIL_STAMP,
    });
  }

  if (shading === 'matcap') {
    return new THREE.MeshMatcapMaterial({
      color,
      matcap: getMatcap(),
      side,
      ...SURFACE_DEPTH_OFFSET,
      ...OUTLINE_STENCIL_STAMP,
    });
  }

  if (shading === 'xray') {
    return new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      ...OUTLINE_STENCIL_STAMP,
    });
  }

  return new THREE.MeshLambertMaterial({
    color,
    side,
    flatShading: false,
    ...SURFACE_DEPTH_OFFSET,
    ...OUTLINE_STENCIL_STAMP,
  });
}

/** Red backfaces make inverted normals obvious before an export. */
export function createFaceOrientationMaterial(): THREE.Material {
  return new THREE.MeshBasicMaterial({
    color: VIEWPORT_COLORS.red,
    side: THREE.BackSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
}

/**
 * The wireframe, and the red one drawn over it for the selected edges.
 *
 * `LineMaterial` rather than `LineBasicMaterial`, for the lift above rather
 * than for width: a plain line takes whatever depth the rasteriser hands it,
 * which is the fill's own, so the wire depended on the fill being sunk under
 * it and that is not enough on a face seen at an angle. As quads the wire is
 * drawn at a depth of its own choosing (see `liftWire`). The cost is
 * `resolution`, which the shader needs to turn a pixel width into clip space
 * (see `ObjectView.setResolution`).
 *
 * Both depth-tested, selected or not, for the reason the vertex dots are: a
 * solid or matcap surface is opaque, and a selected edge round the back showing
 * through it reads as running across the face in front.
 *
 * Writing no depth, because every mark on the geometry is drawn after this one
 * and has to come through: a wire that wrote depth while sitting ahead of the
 * surface would hide the vertex-mode fade and the normals drawn on the same
 * edges.
 *
 * Nothing is hidden in x-ray or wireframe shading even so: the first writes no
 * depth and the second draws no fill, so there is nothing for this to test
 * against, which is how a user asks to see through the model.
 */
export function createWireMaterial(selected: boolean): LineMaterial {
  return liftWire(
    new LineMaterial({
      color: selected ? VIEWPORT_COLORS.red : VIEWPORT_COLORS.void,
      linewidth: 1,
      transparent: true,
      opacity: selected ? 1 : 0.55,
      depthTest: true,
      depthWrite: false,
    }),
  );
}

/**
 * The modifier preview's own edges, under the cage in edit mode.
 *
 * Fainter than the cage, which is the mesh you are actually holding: the
 * preview is there to say what the stack is making of it. Without it a
 * subdivision that only cuts faces, moving nothing, leaves edit mode looking
 * exactly as it did before the modifier was added.
 *
 * Quads and the same lift as the cage above it, for the same reason: these
 * lines lie on the shape the stack built and would be eaten at its folds
 * otherwise.
 */
export function createPreviewWireMaterial(): LineMaterial {
  return liftWire(
    new LineMaterial({
      color: VIEWPORT_COLORS.void,
      linewidth: 1,
      transparent: true,
      opacity: 0.3,
      depthTest: true,
      depthWrite: false,
    }),
  );
}

/**
 * The fade along an edge with one end selected, the way vertex mode reads in
 * Blender.
 *
 * Drawn over the plain wireframe rather than in place of it: the colour is the
 * selection red at the selected end and its alpha runs out towards the other,
 * so what shows at the far end is the ordinary wire underneath. A vertex dot is
 * three pixels across and says nothing about which geometry it holds; the fade
 * is what makes a selection readable at a glance while it is being built.
 *
 * Both the colour and the alpha come from the geometry, since they vary along
 * every segment. Alpha per vertex needs a four-component colour attribute:
 * three decides by the attribute's item size, so it has to be built that wide
 * even though the colour itself never changes (see `ObjectView`).
 */
export function createVertexHighlightMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthTest: true,
  });
}

export interface OutlineMaterialOptions {
  color: THREE.ColorRepresentation;
  /** Screen pixels. Needs `resolution` set before it means anything on screen. */
  width: number;
}

/**
 * The line tracing a selected object's silhouette.
 *
 * `LineMaterial` rather than `LineBasicMaterial` because WebGL ignores
 * `linewidth` (every plain line is one pixel whatever it asks for) and this
 * one is user-adjustable, so it has to be drawn as instanced quads instead.
 * The cost is `resolution`: the shader turns a pixel width into clip space
 * itself, so it must be told the viewport size (see `ObjectView.setResolution`).
 *
 * Kept off the object it belongs to, by the stencil its own fill stamps: what
 * survives is the half of the line lying over the background, which is the
 * contour and nothing else. Blender's outline is the same shape for the same
 * reason: an outline is about which object you are holding, and a line through
 * the middle of one says nothing about that.
 *
 * Depth-tested as well, so a contour behind another object goes away with it
 * rather than being drawn across it.
 *
 * That costs a fight with the surface the line lies on, and and a silhouette is
 * the worst place to have it, being where the surface is most edge-on and its
 * depth swings fastest across a pixel. Hence the bias towards the camera here,
 * against the `SURFACE_DEPTH_OFFSET` pushing the fills the other way: between
 * them the line clears the surface it traces. Both are a few units of the depth
 * buffer's own resolution, which is nowhere near enough to climb through the
 * geometry genuinely in front.
 */
export function createOutlineMaterial({ color, width }: OutlineMaterialOptions): LineMaterial {
  return new LineMaterial({
    color,
    linewidth: width,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    stencilWrite: true,
    stencilRef: OUTLINE_STENCIL,
    stencilFunc: THREE.NotEqualStencilFunc,
  });
}

/**
 * The vertex dots of edit mode.
 *
 * Depth-tested, like the plain wireframe: a solid or matcap surface is opaque,
 * and vertices round the back showing through it read as sitting on the face in
 * front: a click near one lands somewhere the user cannot see. The surface's
 * own depth offset is what keeps the dots on the near side visible, since a
 * vertex and the faces meeting at it share a depth to the last bit.
 *
 * Nothing is hidden in x-ray or wireframe shading even so: neither writes any
 * depth for this to test against.
 */
const POINT_SIZE = 3;

/** How much the vertex under the pointer grows over an idle one. */
const HOVER_POINT_SCALE = 1.8;

/** Bigger than a vertex dot: one object has one, and it has to read at a glance. */
const ORIGIN_POINT_SIZE = 8;

export function createPointMaterial(): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    size: POINT_SIZE,
    sizeAttenuation: false,
    vertexColors: true,
    depthTest: true,
  });
}

/**
 * The vertex a click would take.
 *
 * Grown rather than only recoloured, because the case it is there for is two
 * vertices sitting in exactly the same place: a slide run onto its neighbour
 * with auto merge off leaves one dot on screen for two vertices, and selecting
 * the one underneath changed nothing anyone could see. A square larger than the
 * dot it sits on shows through whichever of them is drawn on top.
 *
 * Cyan, the palette's blue: it is nothing else on the geometry, and the red of
 * a selected vertex stays the colour that means selected.
 *
 * Depth-tested like the dots themselves, and drawn after them, so it wins at
 * equal depth without showing through the far side of a solid surface.
 */
export function createHoverPointMaterial(): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    size: POINT_SIZE * HOVER_POINT_SCALE,
    sizeAttenuation: false,
    color: VIEWPORT_COLORS.cyan,
    depthTest: true,
  });
}

/**
 * Marks vertices an operator just created.
 *
 * Deliberately larger and a different hue from both the idle and the selected
 * point: it has to read at a glance against geometry the user is already
 * looking at, and it shows in every select mode, including the ones that draw
 * no points at all.
 *
 * Depth-tested all the same, like every other mark on the geometry: a marker
 * round the back of an opaque surface points at a vertex that is not where it
 * appears to be, and what an operator left on the far side is not something the
 * user can act on from here anyway.
 */
export function createRecentPointMaterial(): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    size: 11,
    sizeAttenuation: false,
    color: VIEWPORT_COLORS.cyan,
    depthTest: true,
    transparent: true,
  });
}

/**
 * The square sitting on an object's origin.
 *
 * The one mark on an object that is never depth-tested. Every other overlay
 * hides behind the surface on purpose, but an origin usually sits inside the
 * mesh, so a depth-tested one would only ever show on an object you can already
 * see through. Blender draws its origin dot over everything for the same reason.
 * Transparent so it sorts after the opaque passes and wins on screen rather
 * than relying on the order objects happen to be added in.
 *
 * Amber rather than the selection red: it marks a point the object carries,
 * not a piece of geometry that is picked.
 */
export function createOriginMaterial(): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    size: ORIGIN_POINT_SIZE,
    sizeAttenuation: false,
    color: VIEWPORT_COLORS.amber,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
}

/**
 * The red wash over the selected faces.
 *
 * Depth-tested like every other edit-mode overlay, so a face selected round the
 * back of a solid or matcap model stays behind it rather than washing the face
 * in front, which reads as having selected something the user never clicked.
 * Lifted towards the camera against the fill's own offset, the way the outline
 * is, so it sits on the faces it marks instead of fighting them.
 *
 * Writes no depth: it is a wash over the surface, not a surface, and the
 * selected edges and vertex dots drawn after it have to come through.
 */
export function createSelectionOverlayMaterial(): THREE.Material {
  return new THREE.MeshBasicMaterial({
    color: VIEWPORT_COLORS.red,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.45,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

export function createNormalsMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: VIEWPORT_COLORS.cyan });
}

export function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    for (const entry of material) entry.dispose();
    return;
  }
  material.dispose();
}
