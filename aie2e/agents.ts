import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type AgentDefinition,
  type AgentEvent,
  type RateLimit,
  loadAgent,
  runAgent,
} from './claude.ts';
import type { Role } from './hub.ts';
import { type RoundFacts, judgePrompt, modelerPrompt } from './prompts.ts';
import {
  type Issue,
  type JudgeId,
  type JudgeVerdict,
  MODELER_SCHEMA,
  type ModelerReport,
  type Stage,
  readModelerReport,
  readVerdict,
  verdictSchema,
} from './rubric.ts';

/** The three agents as the runner sees them: a turn in, a checked answer out. */

export interface ModelerTurn {
  stage: Stage;
  attempt: number;
  stages: readonly Stage[];
  facts: RoundFacts | null;
  open: readonly Issue[];
}

export interface JudgeTurn {
  judge: JudgeId;
  facts: RoundFacts;
  open: readonly Issue[];
}

export interface Outcome<T> {
  ok: boolean;
  value: T | null;
  error: string | null;
  costUsd: number;
  durationMs: number;
  turns: number;
  denials: string[];
  rateLimit: RateLimit | null;
}

export interface Agents {
  modeler(turn: ModelerTurn): Promise<Outcome<ModelerReport>>;
  judge(turn: JudgeTurn): Promise<Outcome<JudgeVerdict>>;
}

/** The agent files the runner loads, by role. */
export const AGENT_FILES = {
  modeler: 'modeler',
  style: 'style-critic',
  topology: 'topology-reviewer',
} as const;

/** Each agent's port on the hub, and what it may do there. */
export const AGENT_ROLES = {
  modeler: 'modeler',
  'style-critic': 'judge',
  'topology-reviewer': 'judge',
} as const satisfies Record<string, Role>;

export type AgentPorts = Record<keyof typeof AGENT_ROLES, number>;

export interface ClaudeAgentOptions {
  root: string;
  dir: string;
  bridge: string;
  ports: AgentPorts;
  effort: { modeler: string; judges: string };
  /** Overrides each agent file's model when set. */
  model: string | null;
  timeouts: { modeler: number; judge: number };
  onEvent: (agent: string, event: AgentEvent) => void;
}

/** Writes the MCP configuration that points a session at the hub through the bridge. */
async function mcpConfig(
  dir: string,
  bridge: string,
  port: number,
  agent: string,
): Promise<string> {
  const path = join(dir, 'agents', `mcp-${agent}.json`);
  const config = {
    mcpServers: { '3doo': { command: process.execPath, args: [bridge, String(port)] } },
  };
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

export async function claudeAgents(options: ClaudeAgentOptions): Promise<Agents> {
  const { dir } = options;
  await mkdir(join(dir, 'agents'), { recursive: true });
  await mkdir(join(dir, 'transcripts'), { recursive: true });
  const configs = {} as Record<keyof AgentPorts, string>;
  for (const [agent, port] of Object.entries(options.ports) as [keyof AgentPorts, number][]) {
    configs[agent] = await mcpConfig(dir, options.bridge, port, agent);
  }
  const load = async (name: string): Promise<AgentDefinition> => {
    const agent = await loadAgent(options.root, name);
    return options.model ? { ...agent, model: options.model } : agent;
  };
  const agents = {
    modeler: await load(AGENT_FILES.modeler),
    style: await load(AGENT_FILES.style),
    topology: await load(AGENT_FILES.topology),
  };
  // One session for the modeller across every turn, so it remembers its own
  // scripts and what it tried; judges start fresh each round, so last
  // round's opinion does not anchor this one.
  const modelerSession = randomUUID();
  // Resumed only once a turn has really started it: a turn that failed to
  // start leaves no session behind to resume.
  let modelerStarted = false;
  let calls = 0;

  const run = async <T>(
    agent: AgentDefinition,
    prompt: string,
    schema: object,
    read: (structured: unknown) => T,
    effort: string,
    session?: { id: string; resume: boolean },
  ): Promise<Outcome<T>> => {
    calls++;
    const role = AGENT_ROLES[agent.name as keyof AgentPorts];
    const result = await runAgent({
      agent,
      prompt,
      schema,
      effort,
      cwd: dir,
      promptFile: join(dir, 'agents', `${agent.name}.md`),
      mcpConfig: configs[agent.name as keyof AgentPorts],
      session,
      transcript: join(dir, 'transcripts', `${String(calls).padStart(2, '0')}-${agent.name}.jsonl`),
      timeoutMs: role === 'modeler' ? options.timeouts.modeler : options.timeouts.judge,
      onEvent: (event) => options.onEvent(agent.name, event),
    });
    if (session && result.sessionId) modelerStarted = true;
    return {
      ok: result.ok,
      value: result.ok ? read(result.structured) : null,
      error: result.error,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      turns: result.turns,
      denials: result.denials,
      rateLimit: result.rateLimit,
    };
  };

  return {
    modeler: (turn) => {
      const session = { id: modelerSession, resume: modelerStarted };
      const prompt = modelerPrompt(turn.facts, turn.stage, turn.attempt, turn.stages, turn.open);
      return run<ModelerReport>(
        agents.modeler,
        prompt,
        MODELER_SCHEMA,
        readModelerReport,
        options.effort.modeler,
        session,
      );
    },
    judge: (turn) =>
      run<JudgeVerdict>(
        agents[turn.judge],
        judgePrompt(turn.judge, turn.facts, turn.open),
        verdictSchema(turn.judge),
        readVerdict,
        options.effort.judges,
      ),
  };
}
