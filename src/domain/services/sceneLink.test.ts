import { describe, expect, it } from 'vitest';

import { decodeScenePayload, encodeScenePayload, sceneLink, scenePayloadIn } from './sceneLink';

const PROJECT = JSON.stringify({ version: 1, name: 'lamp', objects: [], note: 'ação 立方体' });

describe('scene links', () => {
  it('carries the project text there and back', async () => {
    const payload = await encodeScenePayload(PROJECT);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeScenePayload(payload)).toBe(PROJECT);
  });

  it('compresses a repetitive scene well below its own size', async () => {
    const big = JSON.stringify({ verts: Array.from({ length: 4000 }, (_, i) => [i % 7, 0, 1]) });
    const payload = await encodeScenePayload(big);
    expect(payload.length).toBeLessThan(big.length / 4);
  });

  it('opens on the modeling path of the app it is given, whatever trails that', async () => {
    const link = await sceneLink('https://example.com/3doo/?ref=x#old', PROJECT);
    expect(link.startsWith('https://example.com/3doo/modeling#scene=')).toBe(true);
    expect(scenePayloadIn(new URL(link).hash)).toBe(link.split('#scene=')[1]);
  });

  it('finds no scene in a hash without one', () => {
    expect(scenePayloadIn('')).toBeNull();
    expect(scenePayloadIn('#scripting/scene.add')).toBeNull();
    expect(scenePayloadIn('#scene=')).toBeNull();
  });

  it('says so when the payload was cut short', async () => {
    const payload = await encodeScenePayload(PROJECT);
    await expect(decodeScenePayload(payload.slice(0, payload.length / 2))).rejects.toThrow(
      /cut short/,
    );
  });
});
