import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RenderRequest, SceneSummary, TopologyReport } from '../src/app/automation/types.ts';
import type { Engine } from '../mcp/engine.ts';
import { topologyText } from '../mcp/tools.ts';

import type { Picture } from './prompts.ts';
import { type GateResult, gameReadyNotes, measureGates } from './rubric.ts';

/**
 * What the runner measures itself after each modeller turn, the same way every
 * round, so rounds compare and no judge has to remember to look.
 */

interface PictureSpec {
  name: string;
  what: string;
  request: RenderRequest;
}

const THREE_QUARTER = { yaw: 35, pitch: 20 };
const BACK_QUARTER = { yaw: -140, pitch: 15 };

export const PICTURES: readonly PictureSpec[] = [
  {
    name: 'silhouette',
    what: 'Silhouette from the front and the right, in black on white',
    request: {
      views: ['front', 'right'],
      shading: 'silhouette',
      sheet: true,
      width: 1000,
      height: 700,
    },
  },
  {
    name: 'beauty',
    what: 'Solid shading from a three-quarter camera',
    request: { cameras: [THREE_QUARTER], shading: 'solid', width: 900, height: 900 },
  },
  {
    name: 'matcap',
    what: 'Matcap from the other side, which shows how the forms and bevels catch light',
    request: { cameras: [BACK_QUARTER], shading: 'matcap', width: 900, height: 900 },
  },
  {
    name: 'wire',
    what: 'Wireframe over the surface from the front, the right, and three-quarter from both sides',
    request: {
      views: ['front', 'right'],
      cameras: [THREE_QUARTER, BACK_QUARTER],
      shading: 'solidWire',
      sheet: true,
      width: 1200,
      height: 1200,
    },
  },
  {
    name: 'thumb',
    what: 'The axe at icon size, 128 pixels, as a player sees it in an inventory',
    request: { cameras: [THREE_QUARTER], shading: 'solid', width: 128, height: 128, grid: false },
  },
];

export interface RoundMeasure {
  dir: string;
  /** The scene as it stood, as a `.3doo` beside the pictures. */
  project: string | null;
  pictures: Picture[];
  scene: SceneSummary;
  topology: TopologyReport | null;
  topologyText: string;
  gates: GateResult[];
  notes: string[];
}

export async function measureRound(engine: Engine, dir: string): Promise<RoundMeasure> {
  await mkdir(dir, { recursive: true });
  const scene = await engine.scene();
  const empty = scene.objects.length === 0;

  let project: string | null = null;
  const pictures: Picture[] = [];
  let topology: TopologyReport | null = null;
  let text = 'The scene is empty.';
  if (!empty) {
    const [file] = await engine.exportFile({ format: '3doo', name: 'scene' });
    project = join(dir, 'scene.3doo');
    await writeFile(project, Buffer.from(file.base64, 'base64'));
    for (const spec of PICTURES) {
      const [shot] = await engine.render(spec.request);
      const path = join(dir, `${spec.name}.png`);
      await writeFile(path, Buffer.from(shot.base64, 'base64'));
      pictures.push({ name: spec.name, what: spec.what, path });
    }
    topology = await engine.inspect().catch(() => null);
    text = topology ? topologyText(topology) : 'Every object is hidden: nothing to inspect.';
  }

  const measure: RoundMeasure = {
    dir,
    project,
    pictures,
    scene,
    topology,
    topologyText: text,
    gates: measureGates(topology),
    notes: empty ? [] : gameReadyNotes(scene, topology),
  };
  await writeFile(join(dir, 'measure.json'), JSON.stringify(measure, null, 2));
  return measure;
}

export interface RoundTrip {
  format: 'fbx' | 'obj';
  files: string[];
  ok: boolean;
  detail: string;
}

/**
 * Exports the finished asset as FBX and OBJ, opens each into an empty scene
 * and counts it again: what a game engine reads has to be what was modelled.
 * The scene is put back as it was afterwards.
 */
export async function roundTrip(engine: Engine, dir: string): Promise<RoundTrip[]> {
  await mkdir(dir, { recursive: true });
  const [saved] = await engine.exportFile({ format: '3doo', name: 'axe' });
  await writeFile(join(dir, saved.name), Buffer.from(saved.base64, 'base64'));
  const before = await engine.inspect().catch(() => null);
  const trips: RoundTrip[] = [];

  for (const format of ['fbx', 'obj'] as const) {
    const files: string[] = [];
    try {
      const exported = await engine.exportFile({ format, name: 'axe', preset: 'unity' });
      for (const file of exported) {
        const path = join(dir, file.name);
        await writeFile(path, Buffer.from(file.base64, 'base64'));
        files.push(path);
      }
      await engine.reset();
      await engine.open({ name: exported[0].name, base64: exported[0].base64 });
      const after = await engine.inspect();
      const out = before?.totals;
      const back = after.totals;
      const same =
        !!out && out.faces === back.faces && out.tris === back.tris && out.ngons === back.ngons;
      trips.push({
        format,
        files,
        ok: same,
        detail: `${out?.faces ?? '?'} faces and ${out?.tris ?? '?'} triangles went out, ${back.faces} faces and ${back.tris} triangles came back in.`,
      });
    } catch (error) {
      trips.push({ format, files, ok: false, detail: (error as Error).message });
    }
  }

  await engine.reset();
  await engine.open({ name: saved.name, base64: saved.base64 });
  return trips;
}
