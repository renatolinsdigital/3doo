import {
  BRIEF,
  type GateResult,
  type Issue,
  type JudgeId,
  STYLE_CRITERIA,
  type Stage,
  TOPOLOGY_CRITERIA,
  TRI_BUDGET,
} from './rubric.ts';

/**
 * What the runner tells each agent at the start of its turn. The standing
 * instructions live in the agent files; these carry the round: the stage, what
 * was measured and what the judges still want.
 */

export interface Picture {
  name: string;
  what: string;
  path: string;
}

export interface RoundFacts {
  stage: Stage;
  attempt: number;
  /** Every stage, in order, so an agent knows what comes later. */
  stages: readonly Stage[];
  gates: readonly GateResult[];
  notes: readonly string[];
  topologyText: string;
  pictures: readonly Picture[];
}

const issueLine = (issue: Issue) => {
  const answer = issue.response
    ? ` The modeller ${issue.response.action === 'fixed' ? 'says it fixed this' : 'disputes this'}: ${issue.response.note}`
    : '';
  return `- ${issue.id} [${issue.severity}] ${issue.where}: ${issue.problem} Fix: ${issue.fix}${answer}`;
};

const stagePlan = (stages: readonly Stage[], current: Stage) =>
  stages
    .map((stage) => `${stage.id === current.id ? '>' : '-'} ${stage.title}: ${stage.goal}`)
    .join('\n');

const gateLines = (stage: Stage, gates: readonly GateResult[]) =>
  gates
    .filter((gate) => stage.gates.includes(gate.id))
    .map((gate) => `- ${gate.id}: ${gate.pass ? 'holds' : 'FAILS'}. ${gate.detail}`)
    .join('\n');

/** The modeller's turn: the stage to reach, and everything the last check found. */
export function modelerPrompt(
  facts: RoundFacts | null,
  stage: Stage,
  attempt: number,
  stages: readonly Stage[],
  open: readonly Issue[],
): string {
  const lines = [
    `The brief: "${BRIEF}".`,
    `Budget: ${TRI_BUDGET.min} to ${TRI_BUDGET.max} triangles in the finished asset, as inspect_mesh counts them (tris). No n-gons at all by the end.`,
    '',
    `Stage ${stages.indexOf(stage) + 1} of ${stages.length}, attempt ${attempt} of ${stage.attempts}. The stages:`,
    stagePlan(stages, stage),
    '',
  ];
  if (!facts) {
    lines.push(
      'The scene is empty. Start the axe now. Read scripting_reference first if you have not in this session.',
    );
  } else {
    lines.push(
      'The scene is as you left it at the end of your last turn. What the runner measured after it:',
      '',
      'Gates for this stage:',
      gateLines(stage, facts.gates) || '- none',
      '',
      facts.topologyText,
    );
    if (facts.notes.length > 0) {
      lines.push('', 'Game-ready notes:', ...facts.notes.map((note) => `- ${note}`));
    }
  }
  if (open.length > 0) {
    lines.push(
      '',
      'Issues the judges raised that are still open. Answer every one in responses: fixed, or disputed with your reason. A dispute the judge rejects goes to a person, so dispute only what you believe is wrong.',
      ...open.map(issueLine),
    );
  }
  lines.push(
    '',
    'Work until this stage is met, checking with render_views and inspect_mesh, then end your turn with the JSON answer. Leave the scene as the version you want judged.',
  );
  return lines.join('\n');
}

/**
 * A judge's turn: the pictures the runner took, and its own open issues. Only
 * the topology judge gets the measured numbers. Given them, the style judge
 * spent its issues on triangle counts and transforms, which are the other
 * judge's to raise, and blocked a blockout over a budget meant for the finish.
 */
export function judgePrompt(judge: JudgeId, facts: RoundFacts, open: readonly Issue[]): string {
  const style = judge === 'style';
  const criteria = style ? STYLE_CRITERIA : TOPOLOGY_CRITERIA;
  const { stage } = facts;
  const lines = [
    style
      ? `The brief: "${BRIEF}". You judge style and appeal only; a technical artist judges topology, triangle counts, transforms and export separately, so leave those out of your issues.`
      : `The brief: "${BRIEF}". Budget: ${TRI_BUDGET.min} to ${TRI_BUDGET.max} triangles, no n-gons in the finished asset.`,
    '',
    `You are judging stage ${facts.stages.indexOf(stage) + 1} of ${facts.stages.length}, attempt ${facts.attempt}: ${stage.title}.`,
    `What this stage asks for: ${stage.goal}`,
    `It passes at a score of ${stage.passScore[judge]} from you, with nothing blocking left open. Judge what this stage asks for; detail that belongs to a later stage is not a fault yet, though you may say what it will need.`,
    `Score each of these criteria from 0 to 10: ${criteria.join(', ')}.`,
    '',
    'Pictures the runner took of the scene, which you read with the Read tool:',
    ...facts.pictures.map((picture) => `- ${picture.what}: ${picture.path}`),
  ];
  if (!style) {
    lines.push(
      '',
      'The gates the runner measured:',
      ...facts.gates.map(
        (gate) => `- ${gate.id}: ${gate.pass ? 'holds' : 'FAILS'}. ${gate.detail}`,
      ),
      '',
      facts.topologyText,
    );
    if (facts.notes.length > 0) {
      lines.push('', 'Game-ready notes:', ...facts.notes.map((note) => `- ${note}`));
    }
  }
  if (open.length > 0) {
    lines.push(
      '',
      'Issues you raised earlier that are still open. Give each a status in previous: fixed, open, or withdrawn when the modeller convinced you.',
      ...open.map(issueLine),
    );
  }
  lines.push(
    '',
    'Raise only new issues in issues; do not repeat an open one. Then end your turn with the JSON answer.',
  );
  return lines.join('\n');
}
