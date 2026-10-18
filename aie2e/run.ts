import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { readConfig } from '../mcp/config.ts';
import { BrowserEngine, serveDist } from '../mcp/engine.ts';

import { AGENT_FILES, AGENT_ROLES, type Agents, claudeAgents } from './agents.ts';
import { limitReached, type RateLimit } from './claude.ts';
import { dryRunAgents } from './dryRun.ts';
import {
  type KeptEditor,
  keepEditorOpen,
  openEditor,
  runSmoke,
  showScene,
  showStatus,
} from './editor.ts';
import { SceneHub, serialized } from './hub.ts';
import { type RoundMeasure, type RoundTrip, measureRound, roundTrip } from './measure.ts';
import type { RoundFacts } from './prompts.ts';
import { type RoundRecord, type RunRecord, writeReport } from './report.ts';
import {
  BRIEF,
  IssueLedger,
  type JudgeId,
  type JudgeVerdict,
  STAGES,
  type Stage,
  stageOutcome,
} from './rubric.ts';

/**
 * `npm run aie2e`: three agents build the brief's axe in 3DOO and judge it,
 * while the runner drives the editor's main functions by hand, measures every
 * round and writes a report. See docs/how_aie2e_agents_work.md.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'aie2e', 'bridge.ts');

const USAGE = `npm run aie2e -- [options]

  --dry-run             Scripted stand-ins for the agents: checks the runner, costs nothing
  --stages <list>       Stages to run, in order (default blockout,forms,finish)
  --attempts <n>        Attempts per stage, instead of each stage's own
  --model <name>        Model for every agent instead of the agent files' (opus, sonnet...)
  --effort <level>      The modeller's effort (default medium; high thinks longer per step)
  --judge-effort <lvl>  The judges' effort (default medium)
  --max-usage <0..1>    Stop before a turn once the usage window is this full
  --headless            No editor window; the smoke test runs unseen
  --no-build            Use dist/ as it is
  --no-smoke            Skip driving the editor by hand
  --no-open             Do not open the report at the end
  --out <dir>           Where the run goes (default ~/3doo-output/aie2e/<time>)
  --help`;

const { values: flags } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    stages: { type: 'string' },
    attempts: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string', default: 'medium' },
    'judge-effort': { type: 'string', default: 'medium' },
    'max-usage': { type: 'string' },
    headless: { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false },
    'no-smoke': { type: 'boolean', default: false },
    'no-open': { type: 'boolean', default: false },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

function chosenStages(): Stage[] {
  const attempts = flags.attempts === undefined ? null : Number(flags.attempts);
  if (attempts !== null && (!Number.isInteger(attempts) || attempts < 1)) {
    throw new Error('--attempts has to be a whole number, 1 or more.');
  }
  const ids = flags.stages
    ? flags.stages.split(',').map((id) => id.trim())
    : STAGES.map((stage) => stage.id);
  return ids.map((id) => {
    const stage = STAGES.find((candidate) => candidate.id === id);
    if (!stage)
      throw new Error(
        `There is no stage "${id}". The stages are ${STAGES.map((s) => s.id).join(', ')}.`,
      );
    return attempts === null ? stage : { ...stage, attempts };
  });
}

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const say = (line: string) => process.stdout.write(`${line}\n`);
const clip = (text: string, limit = 110) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

function openFile(path: string): void {
  const url = pathToFileURL(path).href;
  const [command, ...args] =
    process.platform === 'win32'
      ? ['rundll32.exe', 'url.dll,FileProtocolHandler']
      : process.platform === 'darwin'
        ? ['open']
        : ['xdg-open'];
  spawn(command, [...args, url], { detached: true, stdio: 'ignore' })
    .on('error', () => {})
    .unref();
}

async function main(): Promise<void> {
  if (flags.help) {
    say(USAGE);
    return;
  }
  const stages = chosenStages();
  const maxUsage = flags['max-usage'] === undefined ? null : Number(flags['max-usage']);
  const dryRun = flags['dry-run'];
  const startedAt = new Date();
  const dir = flags.out ?? join(homedir(), '3doo-output', 'aie2e', stamp(startedAt));
  await mkdir(dir, { recursive: true });
  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };

  say(`AIE2E: "${BRIEF}"${dryRun ? ', dry run' : ''}`);
  say(`Stages: ${stages.map((stage) => `${stage.id} x${stage.attempts}`).join(', ')}`);
  say(`Run folder: ${dir}`);

  if (!flags['no-build']) {
    say('Building the app...');
    const { build } = await import('vite');
    await build({ root: ROOT, logLevel: 'warn' });
  }

  const served = await serveDist(join(ROOT, 'dist'));
  const config = {
    ...readConfig(process.env, ROOT),
    engineUrl: served.url,
    outputDir: join(dir, 'files'),
    timeoutMs: 120_000,
  };
  const engine = serialized(new BrowserEngine(config));
  const hub = new SceneHub(engine, config, version);
  const ports = await hub.listen(AGENT_ROLES);

  let kept: KeptEditor | null = null;
  const record: RunRecord = {
    brief: BRIEF,
    dir,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    mode: dryRun ? 'dry run' : 'claude',
    smoke: null,
    rounds: [],
    stages: [],
    issues: [],
    calls: hub.calls,
    findings: [],
    roundTrip: [],
    final: null,
    assetPassed: false,
    verdict: '',
    stopped: null,
    costUsd: 0,
    rateLimit: null,
  };
  const ledger = new IssueLedger();
  record.issues = ledger.issues;

  let finishing = false;
  const finish = async (): Promise<void> => {
    if (finishing) return;
    finishing = true;
    // First, so the window closing on Ctrl+C is not taken for the user closing it.
    const closing = kept?.close();
    record.finishedAt = new Date().toISOString();
    const report = await writeReport(record).catch((error: Error) => {
      say(`Could not write the report: ${error.message}`);
      return null;
    });
    await closing;
    await hub.close();
    await engine.close();
    served.server.close();
    if (report) {
      say(`\nReport: ${report}`);
      if (!flags['no-open']) openFile(report);
    }
  };
  process.once('SIGINT', () => {
    record.stopped = 'interrupted with Ctrl+C';
    say('\nInterrupted: writing the report for what ran so far.');
    void finish().then(() => process.exit(130));
  });

  try {
    await run();
  } finally {
    await finish();
  }

  async function run(): Promise<void> {
    // ------------------------------------------------------------ editor
    const first = await openEditor(served.url, flags.headless).catch((error: Error) => {
      record.findings.push({ source: 'runner', kind: 'no window', detail: error.message });
      say(`No editor window: ${error.message}`);
      return null;
    });
    let following = false;
    let lastStatus = '';
    const editor = keepEditorOpen(
      first,
      () => openEditor(served.url, flags.headless),
      async (window) => {
        if (lastStatus) await showStatus(window, lastStatus);
        if (following) await mirror();
      },
      (failure) =>
        say(
          failure
            ? `  The editor window was closed and could not open again: ${failure}`
            : '  The editor window was closed: opened it again.',
        ),
    );
    kept = editor;
    const smokeWindow = editor.current();
    if (smokeWindow && !flags['no-smoke']) {
      say('\nDriving the editor by hand...');
      await mkdir(join(dir, 'smoke'), { recursive: true });
      record.smoke = await runSmoke(smokeWindow, served.url, join(dir, 'smoke'));
      for (const step of record.smoke) {
        say(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.name}: ${step.detail}`);
        if (!step.ok)
          record.findings.push({
            source: 'smoke',
            kind: 'broken',
            detail: `${step.name}: ${step.detail}`,
          });
      }
    }

    // A modeller's script changes the scene; the window follows it.
    let mirroring = false;
    let again = false;
    async function mirror(): Promise<void> {
      if (mirroring) {
        again = true;
        return;
      }
      mirroring = true;
      try {
        do {
          again = false;
          const window = editor.current();
          if (!window) break;
          const [file] = await engine.exportFile({ format: '3doo', name: 'axe' });
          await showScene(window, file).catch(() => {});
        } while (again);
      } finally {
        mirroring = false;
      }
    }
    hub.onChange = mirror;
    following = true;

    // ------------------------------------------------------------ agents
    const agents: Agents = dryRun
      ? dryRunAgents(BRIDGE, ports)
      : await claudeAgents({
          root: ROOT,
          dir,
          bridge: BRIDGE,
          ports,
          effort: { modeler: flags.effort, judges: flags['judge-effort'] },
          model: flags.model ?? null,
          timeouts: { modeler: 45 * 60_000, judge: 15 * 60_000 },
          onEvent: (agent, event) => {
            if (event.kind === 'tool') say(`  [${agent}] ${event.name} ${clip(event.detail)}`);
            else if (event.kind === 'tool-error')
              say(`  [${agent}] ${event.name} failed: ${clip(event.message, 160)}`);
            else if (event.kind === 'text') say(`  [${agent}] ${clip(event.text, 200)}`);
          },
        });
    if (dryRun) {
      hub.onCall = (call) =>
        say(
          `  [${call.agent}] ${call.tool}${call.ok ? '' : ` failed: ${clip(call.error ?? '', 160)}`}`,
        );
    }

    const status = (text: string) => {
      say(`\n${text}`);
      lastStatus = text;
      const window = editor.current();
      if (window) void showStatus(window, text);
    };
    const usage = (limit: RateLimit | null) => {
      if (!limit) return;
      record.rateLimit = limit;
      if (limitReached(limit)) {
        const resets = limit.resetsAt ? new Date(limit.resetsAt * 1000).toLocaleString() : 'later';
        record.stopped = `the Claude usage limit was reached; it resets ${resets}.`;
      } else if (maxUsage !== null && limit.utilization !== null && limit.utilization >= maxUsage) {
        record.stopped = `the usage window reached ${Math.round(limit.utilization * 100)}%, the --max-usage set.`;
      }
    };

    let round = 0;
    let facts: RoundFacts | null = null;
    let lastMeasure: RoundMeasure | null = null;
    let modelerFailures = 0;

    for (const stage of stages) {
      let passed = false;
      let attempts = 0;
      for (let attempt = 1; attempt <= stage.attempts && !record.stopped; attempt++) {
        attempts = attempt;
        round++;
        const entry: RoundRecord = {
          stage: stage.id,
          stageTitle: stage.title,
          attempt,
          modeler: null,
          measure: null,
          judges: {},
          outcome: null,
        };
        record.rounds.push(entry);

        status(`MODELLER: ${stage.title.toUpperCase()}, ATTEMPT ${attempt} OF ${stage.attempts}`);
        const made = await agents.modeler({ stage, attempt, stages, facts, open: ledger.open() });
        record.costUsd += made.costUsd;
        usage(made.rateLimit);
        entry.modeler = {
          agent: 'modeler',
          ok: made.ok,
          error: made.error,
          costUsd: made.costUsd,
          durationMs: made.durationMs,
          turns: made.turns,
          denials: made.denials,
          report: made.value,
        };
        if (made.value) {
          ledger.respond(made.value.responses);
          for (const friction of made.value.friction) {
            record.findings.push({
              source: 'modeller',
              kind: friction.kind,
              detail: friction.detail,
            });
          }
          say(`  modeller: ${clip(made.value.summary, 300)}`);
        }
        if (!made.ok) {
          modelerFailures++;
          record.findings.push({
            source: 'runner',
            kind: 'modeller turn failed',
            detail: made.error ?? 'unknown',
          });
          say(`  The modeller's turn failed: ${made.error}`);
          if (modelerFailures >= 2)
            record.stopped ??= `the modeller failed twice in a row: ${made.error}`;
          if (record.stopped) break;
        } else {
          modelerFailures = 0;
        }

        const measure = await measureRound(
          engine,
          join(dir, 'rounds', `${String(round).padStart(2, '0')}-${stage.id}-${attempt}`),
        );
        entry.measure = measure;
        lastMeasure = measure;
        const roundFacts: RoundFacts = {
          stage,
          attempt,
          stages,
          gates: measure.gates,
          notes: measure.notes,
          topologyText: measure.topologyText,
          pictures: measure.pictures,
        };
        facts = roundFacts;
        for (const gate of measure.gates.filter((candidate) =>
          stage.gates.includes(candidate.id),
        )) {
          say(`  gate ${gate.id}: ${gate.pass ? 'holds' : 'FAILS'}. ${gate.detail}`);
        }

        // The judges only look, each on its own port, so they look at once.
        const verdicts: Partial<Record<JudgeId, JudgeVerdict>> = {};
        const judges = record.stopped ? [] : stage.judges;
        if (judges.length > 0) {
          status(
            `${judges.map((judge) => judge.toUpperCase()).join(' AND ')} ${judges.length > 1 ? 'JUDGES' : 'JUDGE'}: ${stage.title.toUpperCase()}, ATTEMPT ${attempt}`,
          );
        }
        const results = await Promise.all(
          judges.map((judge) =>
            agents.judge({ judge, facts: roundFacts, open: ledger.open(judge) }),
          ),
        );
        for (const [index, judge] of judges.entries()) {
          const judged = results[index];
          record.costUsd += judged.costUsd;
          usage(judged.rateLimit);
          entry.judges[judge] = {
            agent: AGENT_FILES[judge],
            ok: judged.ok,
            error: judged.error,
            costUsd: judged.costUsd,
            durationMs: judged.durationMs,
            turns: judged.turns,
            denials: judged.denials,
            verdict: judged.value,
          };
          if (judged.value) {
            verdicts[judge] = judged.value;
            const added = ledger.apply(judge, stage.id, judged.value);
            say(
              `  ${judge}: ${judged.value.pass ? 'pass' : 'not yet'}, ${judged.value.score}/10, ${added.length} new issues. ${clip(judged.value.summary, 220)}`,
            );
          } else {
            record.findings.push({
              source: 'runner',
              kind: `${judge} judge failed`,
              detail: judged.error ?? 'unknown',
            });
            say(`  The ${judge} judge failed: ${judged.error}`);
          }
        }

        entry.outcome = stageOutcome(stage, measure.gates, verdicts, ledger);
        if (entry.outcome.pass) {
          passed = true;
          say(`  ${stage.title} passed.`);
          break;
        }
        say(`  ${stage.title} not passed yet: ${entry.outcome.reasons.join(' ')}`);
      }
      record.stages.push({ id: stage.id, title: stage.title, pass: passed, attempts });
      if (record.stopped) break;
    }

    // ------------------------------------------------------------ finish
    record.final = lastMeasure;
    if (lastMeasure && lastMeasure.scene.objects.length > 0) {
      status('EXPORTING AND READING BACK FBX AND OBJ');
      const trips: RoundTrip[] = await roundTrip(engine, join(dir, 'final'));
      record.roundTrip = trips;
      for (const trip of trips) {
        say(`  ${trip.format}: ${trip.ok ? 'ok' : 'FAIL'}. ${trip.detail}`);
        if (!trip.ok)
          record.findings.push({ source: 'round trip', kind: trip.format, detail: trip.detail });
      }
      await mirror();
    }
    for (const call of hub.calls) {
      if (!call.ok && call.tool !== 'run_script' && call.role === 'modeler') {
        record.findings.push({ source: 'tool', kind: call.tool, detail: call.error ?? '' });
      }
    }

    const allStages =
      record.stages.length === stages.length && record.stages.every((stage) => stage.pass);
    const exported = record.roundTrip.length > 0 && record.roundTrip.every((trip) => trip.ok);
    record.assetPassed = allStages && exported && !record.stopped;
    const software = record.findings.filter((finding) => finding.source !== 'runner').length;
    record.verdict = record.assetPassed
      ? `The axe cleared every gate and both judges, and exports and reads back as modelled: 3DOO allowed a game-ready medium poly asset in this run.${software > 0 ? ` ${software} findings about the software are listed below.` : ''}`
      : `The axe did not clear the bar${record.stopped ? ' before the run stopped' : ''}. ${
          record.stages
            .filter((stage) => !stage.pass)
            .map((stage) => `${stage.title} did not pass.`)
            .join(' ') || (exported ? '' : 'The export round trip failed.')
        } ${software > 0 ? `${software} findings about the software are listed below.` : ''}`.trim();
    status(record.assetPassed ? 'DONE: THE AXE PASSED' : 'DONE: THE AXE DID NOT PASS');
    say(record.verdict);
    process.exitCode = record.assetPassed && (record.smoke ?? []).every((step) => step.ok) ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`aie2e: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
