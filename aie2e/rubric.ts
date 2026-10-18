import type { SceneSummary, TopologyData, TopologyReport } from '../src/app/automation/types.ts';

/**
 * What the agents are asked to build and the bar it has to clear. The numbers
 * here are measured by code; only the judges' scores come from a model.
 */

export const BRIEF = '3D axe, game ready asset, medium poly, stylized';

/** "Medium poly", counted as the triangles an engine draws. */
export const TRI_BUDGET = { min: 1500, max: 5000 } as const;

/** A hand axe is somewhere between a hatchet and a great axe, in metres. */
export const LENGTH_RANGE = { min: 0.4, max: 1.6 } as const;

export type JudgeId = 'style' | 'topology';
export type StageId = 'blockout' | 'forms' | 'finish';

export interface Stage {
  id: StageId;
  title: string;
  /** What the modeller works toward in this stage, as the modeller's prompt states it. */
  goal: string;
  judges: readonly JudgeId[];
  /** The lowest judge score that passes, out of 10. */
  passScore: Record<JudgeId, number>;
  /** The measured gates that have to hold before the stage passes. */
  gates: readonly GateId[];
  attempts: number;
}

export const STAGES: readonly Stage[] = [
  {
    id: 'blockout',
    title: 'Blockout',
    goal: 'The big shapes and their proportions only: the head, the blade and its edge, the haft, the grip and the pommel. A silhouette that reads as a stylized axe from the front and the side. No detail yet.',
    judges: ['style'],
    passScore: { style: 6, topology: 0 },
    gates: ['notEmpty'],
    attempts: 2,
  },
  {
    id: 'forms',
    title: 'Forms',
    goal: 'The secondary forms and the shape language: taper, chunky exaggerated proportions, bevels that catch the light, the wrap of the grip, a beard or spike if the design wants one. Keep the topology clean as you go: quads, no holes, no faces turned the wrong way.',
    judges: ['style', 'topology'],
    passScore: { style: 7, topology: 6 },
    gates: ['notEmpty', 'manifold', 'facing'],
    attempts: 2,
  },
  {
    id: 'finish',
    title: 'Finish',
    goal: 'A game-ready asset: no n-gons at all, closed and clean meshes, a triangle count inside the budget, hard edges marked and the rest smooth shaded, a small palette through material slots, objects named, rotation and scale applied, and the axe at a believable size standing on the ground.',
    judges: ['style', 'topology'],
    passScore: { style: 7.5, topology: 8 },
    gates: ['notEmpty', 'manifold', 'facing', 'noNgons', 'clean', 'budget'],
    attempts: 3,
  },
];

// ------------------------------------------------------------------ gates

export type GateId = 'notEmpty' | 'manifold' | 'facing' | 'noNgons' | 'clean' | 'budget';

const GATE_IDS: readonly GateId[] = [
  'notEmpty',
  'manifold',
  'facing',
  'noNgons',
  'clean',
  'budget',
];

export interface GateResult {
  id: GateId;
  pass: boolean;
  /** What was measured, in words, failing or not. */
  detail: string;
}

const count = (value: number, one: string, many = `${one}s`) =>
  `${value} ${value === 1 ? one : many}`;

/** Every gate measured against one inspection, whether the stage asks for it or not. */
export function measureGates(report: TopologyReport | null): GateResult[] {
  const totals: TopologyData | null = report?.totals ?? null;
  if (!totals || totals.faces === 0) {
    const detail = 'The scene has no faces.';
    return GATE_IDS.map((id) => ({ id, pass: false, detail }));
  }
  const loose = totals.wireEdges + totals.looseVerts;
  return [
    { id: 'notEmpty', pass: true, detail: `${count(totals.faces, 'face')}.` },
    {
      id: 'manifold',
      pass: totals.nonManifoldEdges === 0 && totals.boundaryEdges === 0,
      detail: `${count(totals.nonManifoldEdges, 'non-manifold edge')}, ${count(totals.boundaryEdges, 'boundary edge')}.`,
    },
    {
      id: 'facing',
      pass: totals.flippedEdges === 0 && totals.insideOutShells === 0,
      detail: `${count(totals.flippedEdges, 'flipped edge')}, ${count(totals.insideOutShells, 'inside-out piece')}.`,
    },
    {
      id: 'noNgons',
      pass: totals.ngons === 0,
      detail:
        totals.ngons === 0
          ? 'No n-gons.'
          : `${count(totals.ngons, 'n-gon')}, the largest with ${totals.maxSides} corners.`,
    },
    {
      id: 'clean',
      pass: loose + totals.duplicateVerts + totals.degenerateFaces === 0,
      detail: `${count(loose, 'loose element')}, ${count(totals.duplicateVerts, 'stacked vertex', 'stacked vertices')}, ${count(totals.degenerateFaces, 'sliver face')}.`,
    },
    {
      id: 'budget',
      pass: totals.tris >= TRI_BUDGET.min && totals.tris <= TRI_BUDGET.max,
      detail: `${totals.tris} triangles, against ${TRI_BUDGET.min} to ${TRI_BUDGET.max}.`,
    },
  ];
}

/**
 * What a game artist would check before an engine import that topology counts
 * do not show. Warnings: they go to the judges and the report, and block nothing.
 */
export function gameReadyNotes(scene: SceneSummary, report: TopologyReport | null): string[] {
  const notes: string[] = [];
  const visible = scene.objects.filter((object) => object.visible);
  const longest = scene.bounds
    ? Math.max(scene.bounds.size.x, scene.bounds.size.y, scene.bounds.size.z)
    : 0;
  if (longest < LENGTH_RANGE.min || longest > LENGTH_RANGE.max) {
    notes.push(
      `The axe is ${longest.toFixed(2)} m along its longest side, outside a believable ${LENGTH_RANGE.min} to ${LENGTH_RANGE.max} m.`,
    );
  }
  if (scene.bounds && Math.abs(scene.bounds.min.y) > 0.02) {
    notes.push(
      `The lowest point is at y ${scene.bounds.min.y.toFixed(3)} m: an asset usually stands on the ground, at y 0.`,
    );
  }
  for (const object of visible) {
    const { scale, rotation } = object;
    if ([scale.x, scale.y, scale.z].some((value) => Math.abs(value - 1) > 1e-3)) {
      notes.push(
        `${object.name} still carries scale ${scale.x}, ${scale.y}, ${scale.z}: apply it.`,
      );
    }
    if ([rotation.x, rotation.y, rotation.z].some((value) => Math.abs(value) > 1e-3)) {
      notes.push(`${object.name} still carries a rotation: apply it.`);
    }
    if (DEFAULT_NAME.test(object.name)) {
      notes.push(`${object.name} has a default name: name it after the part it is.`);
    }
    if (object.modifiers.length > 0) {
      notes.push(
        `${object.name} has live modifiers (${object.modifiers.join(', ')}): they export applied, but check the result.`,
      );
    }
  }
  if (visible.length > 6) {
    notes.push(`${visible.length} objects: a prop usually ships as one to a few named meshes.`);
  }
  const totals = report?.totals;
  if (totals && totals.faces > 0) {
    if (totals.quads / totals.faces < 0.7) {
      notes.push(
        `${Math.round((totals.quads / totals.faces) * 100)}% of the faces are quads: aim for most of them.`,
      );
    }
    if (totals.twistedQuads > 0) {
      notes.push(
        `${count(totals.twistedQuads, 'twisted quad')}: they shade differently from engine to engine.`,
      );
    }
    if (totals.smoothFaces === 0) notes.push('Every face is flat shaded.');
    if (totals.materials < 2 && new Set(visible.map((object) => object.color)).size < 2) {
      notes.push('One colour: a stylized prop usually reads through a small palette.');
    }
  }
  return notes;
}

const DEFAULT_NAME =
  /^(cube|plane|circle|grid|uv ?sphere|ico ?sphere|cylinder|cone|torus|capsule|object|mesh)(\.\d+)?$/i;

// --------------------------------------------------------------- verdicts

export type Severity = 'blocking' | 'major' | 'minor';

export interface NewIssue {
  severity: Severity;
  where: string;
  problem: string;
  fix: string;
}

export interface JudgeVerdict {
  pass: boolean;
  /** Out of 10. */
  score: number;
  criteria: { id: string; score: number; note: string }[];
  /** What became of every issue still open from earlier rounds. */
  previous: { id: string; status: 'fixed' | 'open' | 'withdrawn'; note: string }[];
  issues: NewIssue[];
  summary: string;
}

export interface ModelerReport {
  summary: string;
  responses: { id: string; action: 'fixed' | 'disputed'; note: string }[];
  friction: { kind: 'missing_feature' | 'bug' | 'confusing' | 'workaround'; detail: string }[];
  ready: boolean;
}

export const STYLE_CRITERIA = [
  'silhouette',
  'proportions',
  'shape_language',
  'bevels',
  'palette',
  'cohesion',
  'appeal',
] as const;

export const TOPOLOGY_CRITERIA = [
  'no_ngons',
  'edge_flow',
  'density',
  'poles',
  'shading_setup',
  'budget',
  'game_ready',
] as const;

const issueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'where', 'problem', 'fix'],
  properties: {
    severity: { type: 'string', enum: ['blocking', 'major', 'minor'] },
    where: { type: 'string' },
    problem: { type: 'string' },
    fix: { type: 'string' },
  },
};

/** The JSON a judge has to answer with, which the CLI checks before handing it back. */
export function verdictSchema(judge: JudgeId): object {
  const criteria = judge === 'style' ? STYLE_CRITERIA : TOPOLOGY_CRITERIA;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['pass', 'score', 'summary'],
    properties: {
      pass: { type: 'boolean' },
      score: { type: 'number', minimum: 0, maximum: 10 },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'score', 'note'],
          properties: {
            id: { type: 'string', enum: [...criteria] },
            score: { type: 'number', minimum: 0, maximum: 10 },
            note: { type: 'string' },
          },
        },
      },
      previous: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status', 'note'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['fixed', 'open', 'withdrawn'] },
            note: { type: 'string' },
          },
        },
      },
      issues: { type: 'array', items: issueSchema },
      summary: { type: 'string' },
    },
  };
}

/**
 * The lists in both answers are optional on purpose. The model sometimes folds
 * the field after a long string into that string, as `</summary>
 * <parameter name="responses">[]`; with every field required, the CLI refused
 * the answer five times and the whole turn failed. `readAnswer` takes such a
 * field back out and fills what is missing.
 */
export const MODELER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string' },
    responses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'action', 'note'],
        properties: {
          id: { type: 'string' },
          action: { type: 'string', enum: ['fixed', 'disputed'] },
          note: { type: 'string' },
        },
      },
    },
    friction: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'detail'],
        properties: {
          kind: { type: 'string', enum: ['missing_feature', 'bug', 'confusing', 'workaround'] },
          detail: { type: 'string' },
        },
      },
    },
    ready: { type: 'boolean' },
  },
};

const LEAK = /<\/[a-z_]+>\s*<parameter name="([a-z_]+)">/i;

/** The answer with any field that leaked into a string put back, given ones winning. */
function readAnswer(raw: unknown): Record<string, unknown> {
  const answer = { ...(raw as Record<string, unknown>) };
  for (const [key, value] of Object.entries(answer)) {
    if (typeof value !== 'string' || !LEAK.test(value)) continue;
    const parts = value.split(new RegExp(LEAK.source, 'gi'));
    answer[key] = parts[0].trim();
    for (let i = 1; i < parts.length; i += 2) {
      const name = parts[i];
      if (name in answer) continue;
      const text = parts[i + 1].replace(/<\/parameter>\s*$/, '').trim();
      try {
        answer[name] = JSON.parse(text);
      } catch {
        answer[name] = text;
      }
    }
  }
  return answer;
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

export function readModelerReport(raw: unknown): ModelerReport {
  const answer = readAnswer(raw);
  return {
    summary: String(answer.summary ?? ''),
    responses: list(answer.responses),
    friction: list(answer.friction),
    ready: answer.ready === true,
  };
}

export function readVerdict(raw: unknown): JudgeVerdict {
  const answer = readAnswer(raw);
  return {
    pass: answer.pass === true,
    score: Number(answer.score ?? 0),
    criteria: list(answer.criteria),
    previous: list(answer.previous),
    issues: list(answer.issues),
    summary: String(answer.summary ?? ''),
  };
}

// ----------------------------------------------------------------- ledger

export interface Issue extends NewIssue {
  /** `S-3` for the third style issue, `T-1` for the first topology one. */
  id: string;
  judge: JudgeId;
  stage: StageId;
  status: 'open' | 'fixed' | 'withdrawn' | 'divergence';
  /** The modeller's last answer to it. */
  response?: { action: 'fixed' | 'disputed'; note: string };
  /** The judge's last word on it. */
  note?: string;
}

/**
 * Every issue the judges raised, by id, and what became of each.
 *
 * A judge sees the issues it raised that are still open and says whether each
 * was fixed. An issue the modeller disputed and the judge kept open becomes a
 * divergence: it goes to the report for a person to settle and stops blocking,
 * so one disagreement cannot hold the run in a loop.
 */
export class IssueLedger {
  readonly issues: Issue[] = [];
  private readonly next: Record<JudgeId, number> = { style: 1, topology: 1 };

  open(judge?: JudgeId): Issue[] {
    return this.issues.filter(
      (issue) => issue.status === 'open' && (judge === undefined || issue.judge === judge),
    );
  }

  /** The modeller's answers, recorded against the issues they name. */
  respond(responses: ModelerReport['responses']): void {
    for (const response of responses) {
      const issue = this.issues.find((candidate) => candidate.id === response.id);
      if (issue && issue.status === 'open') issue.response = { ...response };
    }
  }

  /** A judge's verdict: its word on earlier issues, and its new ones, given ids. */
  apply(judge: JudgeId, stage: StageId, verdict: JudgeVerdict): Issue[] {
    for (const word of verdict.previous) {
      const issue = this.issues.find(
        (candidate) => candidate.id === word.id && candidate.judge === judge,
      );
      if (!issue || issue.status !== 'open') continue;
      issue.note = word.note;
      if (word.status === 'open' && issue.response?.action === 'disputed') {
        issue.status = 'divergence';
      } else if (word.status !== 'open') {
        issue.status = word.status;
      }
    }
    const prefix = judge === 'style' ? 'S' : 'T';
    const added = verdict.issues.map((issue): Issue => ({
      ...issue,
      id: `${prefix}-${this.next[judge]++}`,
      judge,
      stage,
      status: 'open',
    }));
    this.issues.push(...added);
    return added;
  }
}

// ------------------------------------------------------------------ stage

export interface StageOutcome {
  pass: boolean;
  /** Why it did not pass, in words; empty when it did. */
  reasons: string[];
}

/** A stage passes when its gates hold, each judge passes it at its score, and nothing blocking is open. */
export function stageOutcome(
  stage: Stage,
  gates: readonly GateResult[],
  verdicts: Partial<Record<JudgeId, JudgeVerdict>>,
  ledger: IssueLedger,
): StageOutcome {
  const reasons: string[] = [];
  for (const id of stage.gates) {
    const gate = gates.find((candidate) => candidate.id === id);
    if (!gate?.pass) reasons.push(`Gate ${id} failed: ${gate?.detail ?? 'not measured.'}`);
  }
  for (const judge of stage.judges) {
    const verdict = verdicts[judge];
    if (!verdict) {
      reasons.push(`The ${judge} judge gave no verdict.`);
      continue;
    }
    if (!verdict.pass) reasons.push(`The ${judge} judge did not pass it.`);
    if (verdict.score < stage.passScore[judge]) {
      reasons.push(
        `The ${judge} judge scored ${verdict.score}, under the ${stage.passScore[judge]} this stage needs.`,
      );
    }
  }
  const blocking = ledger
    .open()
    .filter((issue) => issue.severity === 'blocking' && stage.judges.includes(issue.judge));
  if (blocking.length > 0) {
    reasons.push(`Blocking issues open: ${blocking.map((issue) => issue.id).join(', ')}.`);
  }
  return { pass: reasons.length === 0, reasons };
}
