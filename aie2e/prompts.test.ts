import { describe, expect, it } from 'vitest';

import { type RoundFacts, judgePrompt, modelerPrompt } from './prompts';
import { BRIEF, IssueLedger, STAGES, measureGates } from './rubric';

const [blockout, forms] = STAGES;

const facts: RoundFacts = {
  stage: forms,
  attempt: 1,
  stages: STAGES,
  gates: measureGates(null),
  notes: ['HAFT has a default name.'],
  topologyText: 'Topology of 1 object.',
  pictures: [{ name: 'wire', what: 'Wireframe', path: '/run/rounds/02/wire.png' }],
};

function openIssues() {
  const ledger = new IssueLedger();
  ledger.apply('style', 'blockout', {
    pass: false,
    score: 5,
    criteria: [],
    previous: [],
    issues: [{ severity: 'blocking', where: 'blade', problem: 'Too small.', fix: 'Double it.' }],
    summary: '',
  });
  ledger.respond([{ id: 'S-1', action: 'disputed', note: 'It matches the brief.' }]);
  return ledger.open();
}

describe('modelerPrompt', () => {
  it('starts the first turn on the brief and an empty scene', () => {
    const prompt = modelerPrompt(null, blockout, 1, STAGES, []);
    expect(prompt).toContain(BRIEF);
    expect(prompt).toContain('The scene is empty');
    expect(prompt).toContain('> Blockout');
  });

  it('carries what was measured and every open issue into the next turn', () => {
    const prompt = modelerPrompt(facts, forms, 2, STAGES, openIssues());
    expect(prompt).toContain('- manifold: FAILS');
    expect(prompt).toContain('HAFT has a default name.');
    expect(prompt).toContain('S-1 [blocking] blade: Too small.');
  });
});

describe('judgePrompt', () => {
  it('lists the pictures to read, the criteria to score and the issues to rule on', () => {
    const prompt = judgePrompt('topology', facts, openIssues());
    expect(prompt).toContain('/run/rounds/02/wire.png');
    expect(prompt).toContain('no_ngons, edge_flow');
    expect(prompt).toContain('The modeller disputes this: It matches the brief.');
    expect(prompt).toContain('a score of 6');
    expect(prompt).toContain('Topology of 1 object.');
  });

  it('keeps the measured numbers from the style judge, whose job they are not', () => {
    const prompt = judgePrompt('style', facts, []);
    expect(prompt).toContain('/run/rounds/02/wire.png');
    // With the numbers in hand, the style judge used to raise triangle counts
    // and unapplied transforms, and block a blockout over the finish budget.
    expect(prompt).not.toContain('Topology of 1 object.');
    expect(prompt).not.toContain('manifold');
    expect(prompt).not.toContain('HAFT has a default name.');
  });
});
