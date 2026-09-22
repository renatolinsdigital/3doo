import * as THREE from 'three';

import type { SceneAsset } from '@store/types';

/**
 * One GPU texture per imported image, held for as long as the scene points at
 * it.
 *
 * Keyed by asset id rather than by object: several objects can be drawn with
 * the same picture, and a texture is the expensive half of that. The cache is
 * module scope because the viewport is torn down and rebuilt when the module
 * switches, and re-decoding every reference photograph to come back from the
 * docs page would be a visible stall.
 */
interface TextureSlot {
  texture: THREE.Texture;
  /** Revoked once the image has been decoded, which is the only use it has. */
  url: string;
}

const textures = new Map<string, TextureSlot>();

/**
 * Whether this environment can turn a blob into something an image element
 * will load. Absent in jsdom, where the viewport is stubbed out anyway.
 */
function canCreateObjectUrl(): boolean {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

/**
 * The texture for an asset, decoding it on first ask.
 *
 * The texture comes back before its pixels do: three fills it in when the image
 * lands and the render loop is already drawing every frame, so the picture
 * appears without anything here having to arrange a redraw. Null when the asset
 * has no bytes, which is an image whose file went missing, and the plane then
 * draws in its flat material instead.
 */
export function imageTexture(asset: SceneAsset): THREE.Texture | null {
  const held = textures.get(asset.id);
  if (held) return held.texture;
  if (!asset.blob || !canCreateObjectUrl()) return null;

  const url = URL.createObjectURL(asset.blob);
  const texture = new THREE.TextureLoader().load(url, () => URL.revokeObjectURL(url));
  // The picture is colour, not data: without this it is sampled as linear and
  // every imported photograph comes out washed pale.
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = asset.name;

  textures.set(asset.id, { texture, url });
  return texture;
}

/** Drops the textures for assets the scene no longer holds. */
export function releaseTextures(live: ReadonlySet<string>): void {
  for (const [id, slot] of textures) {
    if (live.has(id)) continue;
    slot.texture.dispose();
    if (canCreateObjectUrl()) URL.revokeObjectURL(slot.url);
    textures.delete(id);
  }
}
