import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { ToolResult } from '../mcp/tools.ts';

import {
  AGENT_FILES,
  type AgentPorts,
  type Agents,
  type JudgeTurn,
  type ModelerTurn,
  type Outcome,
} from './agents.ts';
import type { JudgeVerdict, ModelerReport, StageId } from './rubric.ts';

/**
 * Agents with no model behind them, for `npm run aie2e -- --dry-run`. They
 * reach the scene the way the real ones do, through `bridge.ts` and the hub,
 * so a dry run checks every part of the runner except the thinking, and costs
 * nothing.
 */

/** A minimal MCP client over the bridge, enough to call tools. */
async function connect(bridge: string, port: number) {
  const child = spawn(process.execPath, [bridge, String(port)], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map<number, (value: unknown) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (typeof message.id === 'number') {
      waiting.get(message.id)?.(message.error ? new Error(message.error.message) : message.result);
      waiting.delete(message.id);
    }
  });
  let next = 1;
  const request = (method: string, params: object) =>
    new Promise<unknown>((resolve, reject) => {
      const id = next++;
      waiting.set(id, (value) => (value instanceof Error ? reject(value) : resolve(value)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dry-run', version: '1' },
  });
  return {
    call: (name: string, args: object = {}) =>
      request('tools/call', { name, arguments: args }) as Promise<ToolResult>,
    close: () =>
      new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        child.stdin.end();
      }),
  };
}

const textOf = (result: ToolResult) =>
  result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n');

/** The axe a dry run builds, stage by stage: plain, but every stage really runs. */
const SCRIPTS: Record<StageId, string> = {
  blockout: `
    scene.add('cylinder', { name: 'HAFT', radius: 0.028, height: 0.72, segments: 16, position: [0, 0.36, 0], color: '#8a5a35' });
    scene.add('cube', { name: 'HEAD', position: [0.07, 0.64, 0], scale: [0.24, 0.13, 0.05], color: '#b9c0c7' });
    scene.add('uvSphere', { name: 'POMMEL', radius: 0.04, segments: 16, rings: 8, position: [0, 0.01, 0], color: '#5a3a22' });
  `,
  forms: `
    const head = scene.find('HEAD');
    head.addModifier('subdivide', { levels: 2 });
    scene.find('HAFT').edit((mesh) => {
      mesh.selectFaces((face) => face.sides > 4);
      mesh.triangulate();
    });
  `,
  finish: `
    for (const object of scene.objects) {
      object.applyTransform();
      for (const modifier of object.modifiers) modifier.apply();
      object.edit((mesh) => {
        mesh.selectFaces();
        mesh.shade({ smooth: true });
      });
    }
    const haft = scene.find('HAFT');
    haft.addModifier('subdivide', { levels: 1 });
    haft.modifiers[0].apply();
  `,
};

export function dryRunAgents(bridge: string, ports: AgentPorts): Agents {
  const outcome = <T>(value: T, started: number): Outcome<T> => ({
    ok: true,
    value,
    error: null,
    costUsd: 0,
    durationMs: Date.now() - started,
    turns: 1,
    denials: [],
    rateLimit: null,
  });

  return {
    async modeler(turn: ModelerTurn): Promise<Outcome<ModelerReport>> {
      const started = Date.now();
      const client = await connect(bridge, ports.modeler);
      try {
        const first = turn.stage.id === 'blockout' && turn.attempt === 1;
        const run = await client.call('run_script', {
          script: SCRIPTS[turn.stage.id],
          reset: first,
        });
        const ran = !run.isError || turn.attempt > 1;
        await client.call('render_views', {
          views: ['front'],
          shading: 'silhouette',
          width: 256,
          height: 256,
        });
        await client.call('inspect_mesh');
        return outcome(
          {
            summary: ran
              ? `Ran the ${turn.stage.id} script.`
              : `The ${turn.stage.id} script failed: ${textOf(run).slice(0, 200)}`,
            responses: turn.open.map((issue) => ({
              id: issue.id,
              action: 'fixed' as const,
              note: 'Dry run.',
            })),
            friction: run.isError
              ? [{ kind: 'bug' as const, detail: textOf(run).slice(0, 300) }]
              : [],
            ready: true,
          },
          started,
        );
      } finally {
        await client.close();
      }
    },

    async judge(turn: JudgeTurn): Promise<Outcome<JudgeVerdict>> {
      const started = Date.now();
      const client = await connect(bridge, ports[AGENT_FILES[turn.judge]]);
      try {
        const report = textOf(await client.call('inspect_mesh'));
        // The judges' port has to refuse a script: the dry run proves it does.
        const touched = await client.call('run_script', { script: "scene.add('cube')" });
        const stageGates = turn.facts.gates.filter((gate) =>
          turn.facts.stage.gates.includes(gate.id),
        );
        const failing = stageGates.filter((gate) => !gate.pass);
        const pass = failing.length === 0 && touched.isError === true;
        return outcome(
          {
            pass,
            score: pass ? 8 : 5,
            criteria: [],
            previous: turn.open.map((issue) => ({
              id: issue.id,
              status: 'fixed' as const,
              note: 'Dry run.',
            })),
            issues: [
              ...failing.map((gate) => ({
                severity: 'blocking' as const,
                where: 'the whole asset',
                problem: gate.detail,
                fix: `Make the ${gate.id} gate hold.`,
              })),
              ...(touched.isError
                ? []
                : [
                    {
                      severity: 'blocking' as const,
                      where: 'the hub',
                      problem: 'A judge could run a script.',
                      fix: 'Refuse scripts on the judges port.',
                    },
                  ]),
            ],
            summary: `${turn.judge} dry run: ${report.split('\n')[0]}`,
          },
          started,
        );
      } finally {
        await client.close();
      }
    },
  };
}
