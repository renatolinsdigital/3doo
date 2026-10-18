import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The agents, run as headless Claude Code sessions (`claude -p`) on the
 * user's own Claude login. Each definition is a Claude Code agent file in
 * `.claude/agents/`, so the same three agents work from an interactive session
 * too.
 */

export interface AgentDefinition {
  name: string;
  description: string;
  /** Built-in tool names and `mcp__3doo__*` tool names the agent may call. */
  tools: string[];
  model: string;
  /** The body of the file: the agent's system prompt. */
  prompt: string;
}

/** Reads an agent file: `key: value` frontmatter between `---` lines, then the prompt. */
export function parseAgentFile(text: string): AgentDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('An agent file starts with frontmatter between --- lines.');
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const name = fields.get('name');
  if (!name) throw new Error('An agent file needs a name in its frontmatter.');
  return {
    name,
    description: fields.get('description') ?? '',
    tools: (fields.get('tools') ?? '')
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean),
    model: fields.get('model') ?? 'opus',
    prompt: match[2].trim(),
  };
}

export async function loadAgent(root: string, name: string): Promise<AgentDefinition> {
  return parseAgentFile(await readFile(join(root, '.claude', 'agents', `${name}.md`), 'utf8'));
}

export interface AgentCall {
  agent: AgentDefinition;
  /** What the agent is asked this turn. Sent on stdin, which has no length limit. */
  prompt: string;
  /** The JSON the agent ends its turn with, checked by the CLI. */
  schema: object;
  effort: string;
  /** Where the session runs: outside the repository, so its hooks and CLAUDE.md stay out. */
  cwd: string;
  /** The system prompt, written out once per agent. */
  promptFile: string;
  mcpConfig: string;
  /** A session to start under this id, or to resume when `resume` is on. */
  session?: { id: string; resume: boolean };
  /** Every event of the session, one JSON line each, pictures left out. */
  transcript: string;
  timeoutMs: number;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'tool-error'; name: string; message: string }
  | { kind: 'text'; text: string }
  | { kind: 'rate-limit'; status: string; utilization: number | null };

export interface RateLimit {
  status: string;
  /** How much of the window is used, 0 to 1, when the CLI says. */
  utilization: number | null;
  /** When the window resets, as a Unix time in seconds. */
  resetsAt: number | null;
  window: string | null;
}

export interface AgentResult {
  ok: boolean;
  /** The checked JSON the agent ended its turn with. */
  structured: unknown;
  text: string;
  sessionId: string | null;
  costUsd: number;
  durationMs: number;
  turns: number;
  /** Tool calls the session refused. */
  denials: string[];
  toolErrors: { name: string; message: string }[];
  rateLimit: RateLimit | null;
  error: string | null;
}

/** Names the CLI's `--tools` flag takes: the built-in tools, not the MCP ones. */
export const builtinTools = (tools: readonly string[]) =>
  tools.filter((tool) => !tool.startsWith('mcp__'));

export function cliArgs(call: AgentCall): string[] {
  const args = [
    '-p',
    '--model',
    call.agent.model,
    '--effort',
    call.effort,
    '--system-prompt-file',
    call.promptFile,
    '--tools',
    builtinTools(call.agent.tools).join(','),
    '--allowedTools',
    call.agent.tools.join(','),
    '--permission-mode',
    'dontAsk',
    '--mcp-config',
    call.mcpConfig,
    '--strict-mcp-config',
    // The project's settings carry hooks that would copy these prompts into
    // the user's own prompt history.
    '--setting-sources',
    'user',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(call.schema),
  ];
  if (call.session) {
    args.push(call.session.resume ? '--resume' : '--session-id', call.session.id);
  } else {
    args.push('--no-session-persistence');
  }
  return args;
}

/** A line of the transcript without the pictures in it, which run to megabytes. */
export const withoutPictures = (line: string) =>
  line.replace(/"data":"[A-Za-z0-9+/=]{200,}"/g, '"data":"[picture]"');

const brief = (value: unknown, limit = 160) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

interface StreamState {
  result: Record<string, unknown> | null;
  toolNames: Map<string, string>;
  toolErrors: { name: string; message: string }[];
  rateLimit: RateLimit | null;
  mcpFailed: string | null;
}

/** Reads one line of `--output-format stream-json` into `state`, reporting what happened. */
export function readStreamLine(
  line: string,
  state: StreamState,
  onEvent: (event: AgentEvent) => void = () => {},
): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (message.type === 'system' && message.subtype === 'init') {
    const servers = (message.mcp_servers ?? []) as { name: string; status: string }[];
    const ours = servers.find((server) => server.name === '3doo');
    if (ours && ours.status !== 'connected') state.mcpFailed = ours.status;
  } else if (message.type === 'assistant') {
    const content = ((message.message as { content?: unknown[] })?.content ?? []) as Record<
      string,
      unknown
    >[];
    for (const block of content) {
      if (block.type === 'tool_use') {
        const name = String(block.name).replace(/^mcp__3doo__/, '');
        state.toolNames.set(String(block.id), name);
        if (name !== 'StructuredOutput')
          onEvent({ kind: 'tool', name, detail: brief(block.input) });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        onEvent({ kind: 'text', text: brief(block.text, 240) });
      }
    }
  } else if (message.type === 'user') {
    const content = ((message.message as { content?: unknown })?.content ?? []) as unknown;
    if (!Array.isArray(content)) return;
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_result' || block.is_error !== true) continue;
      const name = state.toolNames.get(String(block.tool_use_id)) ?? 'tool';
      const text = Array.isArray(block.content)
        ? (block.content as { type: string; text?: string }[])
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(' ')
        : String(block.content ?? '');
      state.toolErrors.push({ name, message: brief(text, 400) });
      onEvent({ kind: 'tool-error', name, message: brief(text, 200) });
    }
  } else if (message.type === 'rate_limit_event') {
    const info = (message.rate_limit_info ?? {}) as Record<string, unknown>;
    state.rateLimit = {
      status: String(info.status ?? 'unknown'),
      utilization: typeof info.utilization === 'number' ? info.utilization : null,
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
      window: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
    };
    onEvent({
      kind: 'rate-limit',
      status: state.rateLimit.status,
      utilization: state.rateLimit.utilization,
    });
  } else if (message.type === 'result') {
    state.result = message;
  }
}

/** Runs one turn of an agent and waits for its answer. */
export async function runAgent(call: AgentCall): Promise<AgentResult> {
  const state: StreamState = {
    result: null,
    toolNames: new Map(),
    toolErrors: [],
    rateLimit: null,
    mcpFailed: null,
  };
  await writeFile(call.promptFile, call.agent.prompt);
  const started = Date.now();
  const child = spawn('claude', cliArgs(call), { cwd: call.cwd, windowsHide: true });

  let stderr = '';
  let buffered = '';
  let writes = Promise.resolve();
  const transcribe = (text: string) => {
    writes = writes.then(() => appendFile(call.transcript, text)).catch(() => {});
  };
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      transcribe(`${withoutPictures(line)}\n`);
      readStreamLine(line, state, call.onEvent);
    }
  });
  child.stdin.end(call.prompt);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, call.timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      stderr += error.message;
      resolve(null);
    });
    child.once('close', resolve);
  });
  clearTimeout(timer);
  if (buffered.trim()) readStreamLine(buffered, state, call.onEvent);
  await writes;

  const result = state.result ?? {};
  const failed = (reason: string): AgentResult => ({
    ok: false,
    structured: null,
    text: typeof result.result === 'string' ? result.result : '',
    sessionId: typeof result.session_id === 'string' ? result.session_id : null,
    costUsd: Number(result.total_cost_usd ?? 0),
    durationMs: Date.now() - started,
    turns: Number(result.num_turns ?? 0),
    denials: denialsOf(result),
    toolErrors: state.toolErrors,
    rateLimit: state.rateLimit,
    error: reason,
  });

  if (timedOut) return failed(`stopped after ${Math.round(call.timeoutMs / 60000)} minutes`);
  if (state.mcpFailed) return failed(`the 3doo tools did not connect (${state.mcpFailed})`);
  if (!state.result) {
    return failed(
      `claude exited with code ${exitCode} and no result. ${brief(stderr, 600) || 'Is the claude command installed and logged in?'}`,
    );
  }
  if (result.is_error === true) {
    return failed(`the session ended in an error: ${brief(result.result ?? result.subtype, 400)}`);
  }
  const structured = result.structured_output ?? null;
  if (structured === null) return failed('the agent ended without its JSON answer');
  return {
    ok: true,
    structured,
    text: typeof result.result === 'string' ? result.result : '',
    sessionId: typeof result.session_id === 'string' ? result.session_id : null,
    costUsd: Number(result.total_cost_usd ?? 0),
    durationMs: Number(result.duration_ms ?? Date.now() - started),
    turns: Number(result.num_turns ?? 0),
    denials: denialsOf(result),
    toolErrors: state.toolErrors,
    rateLimit: state.rateLimit,
    error: null,
  };
}

function denialsOf(result: Record<string, unknown>): string[] {
  const denials = Array.isArray(result.permission_denials) ? result.permission_denials : [];
  return denials.map((denial) => {
    const record = denial as { tool_name?: unknown };
    return String(record.tool_name ?? 'a tool').replace(/^mcp__3doo__/, '');
  });
}

/** True when the usage limit has run out, so another turn would only fail. */
export const limitReached = (limit: RateLimit | null) =>
  limit !== null && /rejected|exceeded|blocked/i.test(limit.status);
