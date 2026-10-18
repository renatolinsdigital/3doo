import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { toolList } from '../mcp/tools';

import { AGENT_FILES } from './agents';
import {
  type AgentCall,
  type AgentEvent,
  builtinTools,
  cliArgs,
  limitReached,
  parseAgentFile,
  readStreamLine,
  withoutPictures,
} from './claude';

const agentFile = (name: string) =>
  parseAgentFile(readFileSync(join(__dirname, '..', '.claude', 'agents', `${name}.md`), 'utf8'));

const call = (overrides: Partial<AgentCall> = {}): AgentCall => ({
  agent: agentFile(AGENT_FILES.modeler),
  prompt: 'build',
  schema: { type: 'object' },
  effort: 'high',
  cwd: '/run',
  promptFile: '/run/agents/modeler.md',
  mcpConfig: '/run/agents/mcp-modeler.json',
  transcript: '/run/transcripts/01-modeler.jsonl',
  timeoutMs: 1000,
  ...overrides,
});

const freshState = () => ({
  result: null,
  toolNames: new Map<string, string>(),
  toolErrors: [] as { name: string; message: string }[],
  rateLimit: null,
  mcpFailed: null as string | null,
});

describe('the agent files', () => {
  it('give each agent a name, a model, a prompt and only tools the 3doo server has', () => {
    const served = new Set(toolList().map((tool) => `mcp__3doo__${tool.name}`));
    for (const name of Object.values(AGENT_FILES)) {
      const agent = agentFile(name);
      expect(agent.name).toBe(name);
      expect(agent.model).toBe('opus');
      expect(agent.prompt.length).toBeGreaterThan(500);
      for (const tool of agent.tools.filter((each) => each.startsWith('mcp__'))) {
        expect(served.has(tool), `${name} names ${tool}`).toBe(true);
      }
    }
  });

  it('let only the modeller change the scene, and only the judges read files', () => {
    const modeler = agentFile(AGENT_FILES.modeler);
    expect(modeler.tools).toContain('mcp__3doo__run_script');
    expect(builtinTools(modeler.tools)).toEqual([]);
    for (const name of [AGENT_FILES.style, AGENT_FILES.topology]) {
      const judge = agentFile(name);
      expect(judge.tools.some((tool) => /run_script|open_file|export_model/.test(tool))).toBe(
        false,
      );
      expect(builtinTools(judge.tools)).toEqual(['Read']);
    }
  });
});

describe('cliArgs', () => {
  it('keeps the session to its own MCP server, user settings and the tools it names', () => {
    const args = cliArgs(call());
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--strict-mcp-config');
    expect(after('--setting-sources')).toBe('user');
    expect(after('--tools')).toBe('');
    expect(after('--allowedTools')).toContain('mcp__3doo__run_script');
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(after('--output-format')).toBe('stream-json');
    expect(args).toContain('--no-session-persistence');
  });

  it('starts a session under an id, then resumes it', () => {
    expect(cliArgs(call({ session: { id: 'abc', resume: false } }))).toEqual(
      expect.arrayContaining(['--session-id', 'abc']),
    );
    const resumed = cliArgs(call({ session: { id: 'abc', resume: true } }));
    expect(resumed).toEqual(expect.arrayContaining(['--resume', 'abc']));
    expect(resumed).not.toContain('--no-session-persistence');
  });
});

describe('readStreamLine', () => {
  it('reports tool calls without the server prefix, and failed ones with their message', () => {
    const state = freshState();
    const events: AgentEvent[] = [];
    readStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'mcp__3doo__run_script',
              input: { script: 'scene.add("cube")' },
            },
          ],
        },
      }),
      state,
      (event) => events.push(event),
    );
    readStreamLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              is_error: true,
              content: [{ type: 'text', text: 'line 2: no option "sise"' }],
            },
          ],
        },
      }),
      state,
      (event) => events.push(event),
    );
    expect(events[0]).toMatchObject({ kind: 'tool', name: 'run_script' });
    expect(state.toolErrors).toEqual([{ name: 'run_script', message: 'line 2: no option "sise"' }]);
  });

  it('notices the 3doo server failing to connect, and the usage window', () => {
    const state = freshState();
    readStreamLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: '3doo', status: 'failed' }],
      }),
      state,
    );
    readStreamLine(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          utilization: 0.92,
          resetsAt: 1,
          rateLimitType: 'five_hour',
        },
      }),
      state,
    );
    expect(state.mcpFailed).toBe('failed');
    expect(state.rateLimit).toEqual({
      status: 'allowed_warning',
      utilization: 0.92,
      resetsAt: 1,
      window: 'five_hour',
    });
    expect(limitReached(state.rateLimit)).toBe(false);
    expect(limitReached({ status: 'rejected', utilization: 1, resetsAt: null, window: null })).toBe(
      true,
    );
  });
});

describe('withoutPictures', () => {
  it('leaves the pictures out of a transcript line and keeps the rest', () => {
    const line = `{"type":"image","data":"${'A'.repeat(500)}","mimeType":"image/png"}`;
    expect(withoutPictures(line)).toBe(
      '{"type":"image","data":"[picture]","mimeType":"image/png"}',
    );
  });
});
