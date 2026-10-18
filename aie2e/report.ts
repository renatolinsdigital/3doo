import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { RateLimit } from './claude.ts';
import type { SmokeStep } from './editor.ts';
import type { ToolCall } from './hub.ts';
import type { RoundMeasure, RoundTrip } from './measure.ts';
import {
  BRIEF,
  type Issue,
  type JudgeId,
  type JudgeVerdict,
  type ModelerReport,
  type StageId,
  type StageOutcome,
  TRI_BUDGET,
} from './rubric.ts';

/** One agent turn as the report keeps it. */
export interface TurnRecord {
  agent: string;
  ok: boolean;
  error: string | null;
  costUsd: number;
  durationMs: number;
  turns: number;
  denials: string[];
}

export interface RoundRecord {
  stage: StageId;
  stageTitle: string;
  attempt: number;
  modeler: (TurnRecord & { report: ModelerReport | null }) | null;
  measure: RoundMeasure | null;
  judges: Partial<Record<JudgeId, TurnRecord & { verdict: JudgeVerdict | null }>>;
  outcome: StageOutcome | null;
}

export interface Finding {
  source: 'smoke' | 'round trip' | 'modeller' | 'tool' | 'runner';
  kind: string;
  detail: string;
}

export interface RunRecord {
  brief: string;
  dir: string;
  startedAt: string;
  finishedAt: string;
  mode: 'claude' | 'dry run';
  smoke: SmokeStep[] | null;
  rounds: RoundRecord[];
  stages: { id: StageId; title: string; pass: boolean; attempts: number }[];
  issues: Issue[];
  calls: ToolCall[];
  findings: Finding[];
  roundTrip: RoundTrip[];
  final: RoundMeasure | null;
  assetPassed: boolean;
  verdict: string;
  stopped: string | null;
  costUsd: number;
  rateLimit: RateLimit | null;
}

const escape = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const minutes = (ms: number) => `${(ms / 60000).toFixed(1)} min`;
const mark = (ok: boolean) =>
  `<span class="mark mark--${ok ? 'ok' : 'bad'}">${ok ? 'PASS' : 'FAIL'}</span>`;

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '<p class="empty">None.</p>';
  return `<div class="scroll"><table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

function pictures(measure: RoundMeasure | null, dir: string, names?: readonly string[]): string {
  if (!measure || measure.pictures.length === 0) return '<p class="empty">No pictures.</p>';
  const chosen = names
    ? measure.pictures.filter((picture) => names.includes(picture.name))
    : measure.pictures;
  return `<div class="gallery">${chosen
    .map((picture) => {
      const src = relative(dir, picture.path).replace(/\\/g, '/');
      return `<figure><a href="${escape(src)}"><img src="${escape(src)}" alt="${escape(picture.what)}" loading="lazy"></a><figcaption>${escape(picture.what)}</figcaption></figure>`;
    })
    .join('')}</div>`;
}

function verdictCell(turn: (TurnRecord & { verdict: JudgeVerdict | null }) | undefined): string {
  if (!turn) return '<span class="muted">not asked</span>';
  if (!turn.verdict) return `<span class="bad">${escape(turn.error ?? 'no verdict')}</span>`;
  return `${mark(turn.verdict.pass)} ${turn.verdict.score.toFixed(1)}<br><span class="muted">${escape(turn.verdict.summary)}</span>`;
}

export function reportHtml(run: RunRecord): string {
  const final = run.final;
  const totals = final?.topology?.totals;
  const spent = run.rounds.reduce(
    (sum, round) =>
      sum +
      (round.modeler?.durationMs ?? 0) +
      Object.values(round.judges).reduce((part, judge) => part + (judge?.durationMs ?? 0), 0),
    0,
  );
  const toolFailures = run.calls.filter((call) => !call.ok);

  const sections = [
    `<section class="hero">
      <p class="badges"><span class="badge badge--solid">AIE2E</span><span class="badge">${escape(run.mode.toUpperCase())}</span><span class="badge">${escape(new Date(run.startedAt).toLocaleString('en-GB'))}</span></p>
      <h1>${escape(BRIEF)}</h1>
      <p class="lede">${mark(run.assetPassed)} ${escape(run.verdict)}</p>
      ${run.stopped ? `<p class="stopped">Stopped early: ${escape(run.stopped)}</p>` : ''}
      <dl class="facts">
        <div><dt>STAGES PASSED</dt><dd>${run.stages.filter((stage) => stage.pass).length} of ${run.stages.length}</dd></div>
        <div><dt>TRIANGLES</dt><dd>${totals ? `${totals.tris} <span class="muted">(${TRI_BUDGET.min} to ${TRI_BUDGET.max})</span>` : 'none'}</dd></div>
        <div><dt>N-GONS</dt><dd>${totals ? totals.ngons : 'none'}</dd></div>
        <div><dt>AGENT TIME</dt><dd>${minutes(spent)}</dd></div>
        <div><dt>COST, AS THE CLI PRICES IT</dt><dd>$${run.costUsd.toFixed(2)}</dd></div>
        <div><dt>USAGE LIMIT</dt><dd>${run.rateLimit?.utilization != null ? `${Math.round(run.rateLimit.utilization * 100)}% of the ${escape(run.rateLimit.window ?? '')} window` : 'not reported'}</dd></div>
      </dl>
    </section>`,
    `<section><h2>The asset</h2>${pictures(final, run.dir)}</section>`,
    `<section><h2>Stages</h2>${table(
      ['STAGE', 'RESULT', 'ATTEMPTS'],
      run.stages.map((stage) => [escape(stage.title), mark(stage.pass), String(stage.attempts)]),
    )}</section>`,
    `<section><h2>Gates and game-ready notes</h2>${table(
      ['GATE', 'RESULT', 'MEASURED'],
      (final?.gates ?? []).map((gate) => [escape(gate.id), mark(gate.pass), escape(gate.detail)]),
    )}${
      final && final.notes.length > 0
        ? `<ul class="notes">${final.notes.map((note) => `<li>${escape(note)}</li>`).join('')}</ul>`
        : ''
    }</section>`,
    `<section><h2>Topology</h2>${
      final?.topology
        ? table(
            [
              'OBJECT',
              'TRIS',
              'QUADS',
              'TRIANGLES',
              'N-GONS',
              'POLES 3 / 5 / 6+',
              'SHARP',
              'SMOOTH FACES',
            ],
            [...final.topology.objects, { ...final.topology.totals, name: 'TOTAL' }].map((row) => [
              escape(row.name),
              String(row.tris),
              String(row.quads),
              String(row.triangles),
              String(row.ngons),
              `${row.poles.three} / ${row.poles.five} / ${row.poles.sixPlus}`,
              String(row.sharpEdges),
              String(row.smoothFaces),
            ]),
          )
        : '<p class="empty">Nothing to inspect.</p>'
    }</section>`,
    `<section><h2>Export round trip</h2>${table(
      ['FORMAT', 'RESULT', 'WHAT CAME BACK', 'FILES'],
      run.roundTrip.map((trip) => [
        trip.format.toUpperCase(),
        mark(trip.ok),
        escape(trip.detail),
        trip.files
          .map(
            (file) =>
              `<a href="${escape(relative(run.dir, file).replace(/\\/g, '/'))}">${escape(file.split(/[\\/]/).pop())}</a>`,
          )
          .join('<br>'),
      ]),
    )}</section>`,
    `<section><h2>The editor, driven by hand</h2>${
      run.smoke
        ? table(
            ['STEP', 'RESULT', 'WHAT IT SAW', 'TIME'],
            run.smoke.map((step) => [
              escape(step.name),
              mark(step.ok),
              escape(step.detail),
              `${step.ms} ms`,
            ]),
          )
        : '<p class="empty">Skipped.</p>'
    }</section>`,
    `<section><h2>Findings about the software</h2><p class="muted">What the run found about 3DOO rather than about the axe: smoke failures, exports that changed the model, tools that errored, and what the modeller said it missed or had to work round.</p>${table(
      ['FROM', 'KIND', 'DETAIL'],
      run.findings.map((finding) => [
        escape(finding.source),
        escape(finding.kind),
        escape(finding.detail),
      ]),
    )}</section>`,
    `<section><h2>Issues the judges raised</h2>${table(
      ['ID', 'STAGE', 'SEVERITY', 'STATUS', 'WHERE', 'PROBLEM', 'FIX', 'MODELLER', 'JUDGE'],
      run.issues.map((issue) => [
        escape(issue.id),
        escape(issue.stage),
        escape(issue.severity),
        `<span class="status status--${escape(issue.status)}">${escape(issue.status)}</span>`,
        escape(issue.where),
        escape(issue.problem),
        escape(issue.fix),
        issue.response ? `${escape(issue.response.action)}: ${escape(issue.response.note)}` : '',
        escape(issue.note ?? ''),
      ]),
    )}</section>`,
    `<section><h2>Rounds</h2>${run.rounds
      .map(
        (round) => `<article class="round">
        <h3>${escape(round.stageTitle)}, attempt ${round.attempt} ${round.outcome ? mark(round.outcome.pass) : ''}</h3>
        ${round.modeler ? `<p><b>Modeller</b> (${minutes(round.modeler.durationMs)}, ${round.modeler.turns} turns): ${escape(round.modeler.report?.summary ?? round.modeler.error ?? '')}</p>` : ''}
        ${table(
          ['STYLE', 'TOPOLOGY'],
          [[verdictCell(round.judges.style), verdictCell(round.judges.topology)]],
        )}
        ${round.outcome && !round.outcome.pass ? `<ul class="notes">${round.outcome.reasons.map((reason) => `<li>${escape(reason)}</li>`).join('')}</ul>` : ''}
        ${pictures(round.measure, run.dir, ['silhouette', 'beauty', 'wire'])}
      </article>`,
      )
      .join('')}</section>`,
    `<section><h2>Tool calls</h2><p class="muted">${run.calls.length} calls through the shared scene, ${toolFailures.length} of them failed. Transcripts of every session are in the transcripts folder.</p>${table(
      ['AGENT', 'TOOL', 'ERROR'],
      toolFailures.map((call) => [escape(call.agent), escape(call.tool), escape(call.error)]),
    )}</section>`,
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIE2E report</title>
<style>
  :root { --void:#0b0b0b; --bone:#f4f1ea; --bone-dim:#ddd8cd; --muted:#57534c; --red:#e5342a; --ok:#1f7a4d; --amber:#b86e00; }
  @media (prefers-color-scheme: dark) { :root { --void:#f4f1ea; --bone:#141312; --bone-dim:#2a2826; --muted:#a39e94; --ok:#4cc38a; --amber:#f2a03d; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 64px; font: 14px/1.55 Consolas, 'Courier New', monospace; color: var(--void); background: var(--bone); }
  main { max-width: 1180px; margin: 0 auto; }
  h1 { font: 900 clamp(28px, 5vw, 48px)/1.05 'Arial Black', sans-serif; margin: 16px 0; text-transform: uppercase; }
  h2 { font-size: 13px; letter-spacing: .14em; text-transform: uppercase; border-bottom: 3px solid var(--void); padding-bottom: 6px; margin-top: 40px; }
  h3 { font-size: 15px; }
  .badges { display: flex; flex-wrap: wrap; gap: 0; margin: 0; }
  .badge { padding: 6px 10px; font-size: 11px; font-weight: 700; letter-spacing: .14em; border: 2px solid var(--void); }
  .badge--solid { background: var(--void); color: var(--bone); }
  .lede { font-size: 16px; }
  .stopped { padding: 8px 12px; border: 2px solid var(--amber); color: var(--amber); }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 24px 0 0; }
  .facts div { border: 2px solid var(--void); padding: 10px; }
  .facts dt { font-size: 10px; letter-spacing: .12em; color: var(--muted); }
  .facts dd { margin: 4px 0 0; font-weight: 700; font-size: 18px; }
  .mark { display: inline-block; padding: 1px 6px; font-size: 11px; font-weight: 700; letter-spacing: .1em; color: #fff; }
  .mark--ok { background: var(--ok); }
  .mark--bad { background: var(--red); }
  .muted, .empty { color: var(--muted); }
  .bad { color: var(--red); }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--bone-dim); }
  th { font-size: 10px; letter-spacing: .12em; color: var(--muted); }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 12px; }
  figure { margin: 0; border: 2px solid var(--void); }
  figure img { display: block; width: 100%; height: 220px; object-fit: contain; background: #fff; }
  figcaption { padding: 6px 8px; font-size: 11px; color: var(--muted); }
  .notes li { margin: 4px 0; }
  .round { border-left: 4px solid var(--void); padding-left: 12px; margin: 24px 0; }
  .status--open { color: var(--red); } .status--fixed { color: var(--ok); } .status--divergence { color: var(--amber); }
</style>
</head>
<body>
<main>
${sections.join('\n')}
</main>
</body>
</html>
`;
}

export async function writeReport(run: RunRecord): Promise<string> {
  const path = join(run.dir, 'report.html');
  await writeFile(join(run.dir, 'report.json'), JSON.stringify(run, null, 2));
  await writeFile(path, reportHtml(run));
  return path;
}
