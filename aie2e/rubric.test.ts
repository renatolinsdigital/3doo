import { describe, expect, it } from 'vitest';

import type {
  ObjectSummary,
  SceneSummary,
  TopologyData,
  TopologyReport,
} from '../src/app/automation/types';

import {
  IssueLedger,
  MODELER_SCHEMA,
  type JudgeVerdict,
  STAGES,
  TRI_BUDGET,
  gameReadyNotes,
  measureGates,
  readModelerReport,
  readVerdict,
  stageOutcome,
  verdictSchema,
} from './rubric';

const CLEAN: TopologyData = {
  verts: 1000,
  edges: 2000,
  faces: 1000,
  tris: 2000,
  triangles: 0,
  quads: 1000,
  ngons: 0,
  maxSides: 4,
  nonManifoldEdges: 0,
  boundaryEdges: 0,
  wireEdges: 0,
  looseVerts: 0,
  degenerateFaces: 0,
  duplicateVerts: 0,
  flippedEdges: 0,
  shells: 2,
  insideOutShells: 0,
  poles: { three: 8, five: 4, sixPlus: 0 },
  twoEdgeVerts: 0,
  twistedQuads: 0,
  sharpEdges: 40,
  smoothFaces: 900,
  materials: 3,
};

const report = (totals: Partial<TopologyData> = {}): TopologyReport => {
  const data = { ...CLEAN, ...totals };
  return { objects: [{ ...data, name: 'AXE' }], totals: data };
};

const OBJECT: ObjectSummary = {
  name: 'AXE_HEAD',
  vertices: 500,
  edges: 1000,
  faces: 500,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
  dimensions: { x: 0.3, y: 0.75, z: 0.06 },
  color: '#b9c0c7',
  modifiers: [],
  visible: true,
  group: null,
};

const scene = (objects: ObjectSummary[], minY = 0): SceneSummary => ({
  name: 'axe',
  objects,
  totals: { objects: objects.length, vertices: 500, faces: 500 },
  bounds: {
    min: { x: -0.1, y: minY, z: -0.03 },
    max: { x: 0.2, y: minY + 0.75, z: 0.03 },
    size: { x: 0.3, y: 0.75, z: 0.06 },
  },
});

const verdict = (overrides: Partial<JudgeVerdict> = {}): JudgeVerdict => ({
  pass: true,
  score: 9,
  criteria: [],
  previous: [],
  issues: [],
  summary: 'fine',
  ...overrides,
});

const [, , finish] = STAGES;
const passing = (gates = measureGates(report())) => gates;

describe('measureGates', () => {
  it('passes every gate for a clean mesh inside the budget', () => {
    expect(measureGates(report()).every((gate) => gate.pass)).toBe(true);
  });

  it('fails every gate when there is nothing to measure', () => {
    expect(measureGates(null).every((gate) => !gate.pass)).toBe(true);
  });

  it('fails the n-gon gate on a single n-gon, naming the largest', () => {
    const gate = measureGates(report({ ngons: 1, maxSides: 16 })).find((g) => g.id === 'noNgons');
    expect(gate).toMatchObject({ pass: false, detail: '1 n-gon, the largest with 16 corners.' });
  });

  it('holds the triangle budget at both ends', () => {
    const budget = (tris: number) =>
      measureGates(report({ tris })).some((g) => g.id === 'budget' && g.pass);
    expect(budget(TRI_BUDGET.min)).toBe(true);
    expect(budget(TRI_BUDGET.max)).toBe(true);
    expect(budget(TRI_BUDGET.min - 1)).toBe(false);
    expect(budget(TRI_BUDGET.max + 1)).toBe(false);
  });

  it('fails the manifold gate on a hole and the facing gate on a flipped edge', () => {
    const gates = measureGates(report({ boundaryEdges: 4, flippedEdges: 2 }));
    expect(gates.find((gate) => gate.id === 'manifold')?.pass).toBe(false);
    expect(gates.find((gate) => gate.id === 'facing')?.pass).toBe(false);
  });
});

describe('gameReadyNotes', () => {
  it('has nothing to say about a finished, named asset on the ground', () => {
    expect(gameReadyNotes(scene([OBJECT]), report())).toEqual([]);
  });

  it('notes unapplied scale, default names, live modifiers and an asset off the ground', () => {
    const notes = gameReadyNotes(
      scene(
        [{ ...OBJECT, name: 'Cylinder.001', scale: { x: 2, y: 1, z: 1 }, modifiers: ['subsurf'] }],
        0.3,
      ),
      report(),
    );
    expect(notes.join('\n')).toMatch(/lowest point is at y 0\.300/);
    expect(notes.join('\n')).toMatch(/Cylinder\.001 still carries scale/);
    expect(notes.join('\n')).toMatch(/Cylinder\.001 has a default name/);
    expect(notes.join('\n')).toMatch(/live modifiers \(subsurf\)/);
  });
});

describe('IssueLedger', () => {
  it('numbers each judge its own issues and takes their word on them later', () => {
    const ledger = new IssueLedger();
    const issue = { severity: 'major' as const, where: 'blade', problem: 'flat', fix: 'curve it' };
    ledger.apply('style', 'blockout', verdict({ issues: [issue, issue] }));
    ledger.apply('topology', 'blockout', verdict({ issues: [issue] }));
    expect(ledger.issues.map((each) => each.id)).toEqual(['S-1', 'S-2', 'T-1']);

    ledger.apply(
      'style',
      'forms',
      verdict({ previous: [{ id: 'S-1', status: 'fixed', note: 'yes' }] }),
    );
    expect(ledger.open().map((each) => each.id)).toEqual(['S-2', 'T-1']);
    expect(ledger.open('topology').map((each) => each.id)).toEqual(['T-1']);
  });

  it('ignores a judge ruling on another judge’s issue', () => {
    const ledger = new IssueLedger();
    ledger.apply(
      'topology',
      'forms',
      verdict({ issues: [{ severity: 'minor', where: 'a', problem: 'b', fix: 'c' }] }),
    );
    ledger.apply(
      'style',
      'forms',
      verdict({ previous: [{ id: 'T-1', status: 'withdrawn', note: '' }] }),
    );
    expect(ledger.issues[0].status).toBe('open');
  });

  it('turns an issue the judge keeps after a dispute into a divergence that blocks nothing', () => {
    const ledger = new IssueLedger();
    ledger.apply(
      'topology',
      'finish',
      verdict({
        issues: [
          { severity: 'blocking', where: 'HAFT', problem: 'too dense', fix: 'remove loops' },
        ],
      }),
    );
    ledger.respond([{ id: 'T-1', action: 'disputed', note: 'the loops hold the curve' }]);
    ledger.apply(
      'topology',
      'finish',
      verdict({ previous: [{ id: 'T-1', status: 'open', note: 'still too dense' }] }),
    );

    expect(ledger.issues[0]).toMatchObject({ status: 'divergence', note: 'still too dense' });
    // A disagreement nobody can settle used to be able to hold the stage
    // open until its attempts ran out; it goes to a person instead.
    expect(
      stageOutcome(finish, passing(), { style: verdict(), topology: verdict() }, ledger).pass,
    ).toBe(true);
  });
});

describe('stageOutcome', () => {
  it('passes a stage whose gates hold and whose judges pass it at its score', () => {
    const outcome = stageOutcome(
      finish,
      passing(),
      { style: verdict(), topology: verdict() },
      new IssueLedger(),
    );
    expect(outcome).toEqual({ pass: true, reasons: [] });
  });

  it('says why a stage does not pass', () => {
    const ledger = new IssueLedger();
    ledger.apply(
      'style',
      'finish',
      verdict({ issues: [{ severity: 'blocking', where: 'head', problem: 'small', fix: 'grow' }] }),
    );
    const outcome = stageOutcome(
      finish,
      measureGates(report({ ngons: 2, maxSides: 8 })),
      { style: verdict({ score: 7 }) },
      ledger,
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.reasons.join('\n')).toMatch(/Gate noNgons failed/);
    expect(outcome.reasons.join('\n')).toMatch(/style judge scored 7, under the 7.5/);
    expect(outcome.reasons.join('\n')).toMatch(/topology judge gave no verdict/);
    expect(outcome.reasons.join('\n')).toMatch(/Blocking issues open: S-1/);
  });
});

describe('reading an agent answer', () => {
  it('lets the lists be left out, so a slip in them does not cost the turn', () => {
    // Every list used to be required. When the model's answer folded an empty
    // `responses` into the summary text, the CLI refused it five times and the
    // modeller's whole turn failed, with a finished blockout in the scene.
    expect(MODELER_SCHEMA.required).toEqual(['summary']);
    expect((verdictSchema('style') as { required: string[] }).required).toEqual([
      'pass',
      'score',
      'summary',
    ]);
  });

  it('takes back a field that leaked into the text before it', () => {
    // Taken from a real turn: the model wrote `responses` inside the summary.
    const report = readModelerReport({
      summary:
        'Stage 1 blockout. Parts named AXE_HEAD, HAFT.</summary>\n<parameter name="responses">[{"id":"S-1","action":"fixed","note":"Rebuilt."}]',
      friction: [{ kind: 'confusing', detail: 'scene.bounds is not in the API.' }],
      ready: true,
    });
    expect(report).toEqual({
      summary: 'Stage 1 blockout. Parts named AXE_HEAD, HAFT.',
      responses: [{ id: 'S-1', action: 'fixed', note: 'Rebuilt.' }],
      friction: [{ kind: 'confusing', detail: 'scene.bounds is not in the API.' }],
      ready: true,
    });
  });

  it('keeps a field the answer did give over a leaked copy, and fills missing lists', () => {
    const report = readModelerReport({
      summary: 'Done.</summary>\n<parameter name="ready">false',
      ready: true,
    });
    expect(report).toEqual({ summary: 'Done.', responses: [], friction: [], ready: true });
  });

  it('fills a verdict the same way', () => {
    const verdict = readVerdict({
      pass: true,
      score: 7,
      summary: 'Reads well.</summary>\n<parameter name="previous">[]',
    });
    expect(verdict).toEqual({
      pass: true,
      score: 7,
      criteria: [],
      previous: [],
      issues: [],
      summary: 'Reads well.',
    });
  });
});
