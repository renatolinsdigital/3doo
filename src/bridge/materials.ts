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
 * Sinks the shaded surface a hair into the depth buffer.
 *
 * The wireframe runs along the very edges of the triangles under it, so the two
 * come out of the rasteriser at the same depth and which one survives comes
 * down to float rounding — an edge would show solid on one face, stipple on the
 * next, and change again as the mesh deformed under it. Offsetting the fill
 * (the only thing WebGL can offset: there is no POLYGON_OFFSET_LINE) settles
 * that for good, and a line still disappears properly behind geometry in front.
 *
 * Slope-scaled *and* constant: the factor alone is zero on a polygon facing the
 * camera square on, which is where the flattest, longest edges are.
 */
const SURFACE_DEPTH_OFFSET = {
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
} as const;

export interface SurfaceMaterialOptions {
  color: THREE.ColorRepresentation;
  shading: ShadingMode;
  backfaceCulling: boolean;
}

export function createSurfaceMaterial({
  color,
  shading,
  backfaceCulling,
}: SurfaceMaterialOptions): THREE.Material {
  const side = backfaceCulling ? THREE.FrontSide : THREE.DoubleSide;

  if (shading === 'matcap') {
    return new THREE.MeshMatcapMaterial({
      color,
      matcap: getMatcap(),
      side,
      ...SURFACE_DEPTH_OFFSET,
    });
  }

  if (shading === 'xray') {
    return new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
  }

  return new THREE.MeshLambertMaterial({
    color,
    side,
    flatShading: false,
    ...SURFACE_DEPTH_OFFSET,
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

export function createWireMaterial(selected: boolean): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: selected ? VIEWPORT_COLORS.red : VIEWPORT_COLORS.void,
    transparent: true,
    opacity: selected ? 1 : 0.55,
    depthTest: !selected,
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
 * `linewidth` — every plain line is one pixel whatever it asks for — and this
 * one is user-adjustable, so it has to be drawn as instanced quads instead.
 * The cost is `resolution`: the shader turns a pixel width into clip space
 * itself, so it must be told the viewport size (see `ObjectView.setResolution`).
 *
 * Drawn over everything, like the rest of the selection overlays: the line sits
 * exactly on the surface it traces, so depth testing would leave it fighting
 * the very geometry it is drawing around.
 */
export function createOutlineMaterial({ color, width }: OutlineMaterialOptions): LineMaterial {
  return new LineMaterial({ color, linewidth: width, depthTest: false });
}

export function createPointMaterial(): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    size: 3,
    sizeAttenuation: false,
    vertexColors: true,
    depthTest: false,
  });
}

/**
 * Marks vertices an operator just created.
 *
 * Deliberately larger and a different hue from both the idle and the selected
 * point: it has to read at a glance against geometry the user is already
 * looking at, and it shows in every select mode, including the ones that draw
 * no points at all.
 */
export function createRecentPointMaterial(): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    size: 11,
    sizeAttenuation: false,
    color: VIEWPORT_COLORS.cyan,
    depthTest: false,
    transparent: true,
  });
}

export function createSelectionOverlayMaterial(): THREE.Material {
  return new THREE.MeshBasicMaterial({
    color: VIEWPORT_COLORS.red,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.45,
    depthTest: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
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
