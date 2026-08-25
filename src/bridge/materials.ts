import * as THREE from 'three';

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
    return new THREE.MeshMatcapMaterial({ color, matcap: getMatcap(), side });
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

  return new THREE.MeshLambertMaterial({ color, side, flatShading: false });
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
