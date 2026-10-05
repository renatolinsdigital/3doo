import { describe, expect, it } from 'vitest';

import { completionContext, completions, findImbalance, toLines, tokenize } from './syntax';

/** The non-space tokens as `kind:text`, which is what each test reads. */
function kinds(source: string): string[] {
  return tokenize(source)
    .filter((token) => token.kind !== 'space')
    .map((token) => `${token.kind}:${token.text}`);
}

describe('tokenize', () => {
  it('tells keywords, literals, numbers, strings and comments apart', () => {
    expect(
      kinds(`const n = 1.5e3; // done\nlet s = 'hi' + "there" + \`t\`; if (true) null`),
    ).toEqual([
      'keyword:const',
      'identifier:n',
      'punctuation:=',
      'number:1.5e3',
      'punctuation:;',
      'comment:// done',
      'keyword:let',
      'identifier:s',
      'punctuation:=',
      "string:'hi'",
      'punctuation:+',
      'string:"there"',
      'punctuation:+',
      'string:`t`',
      'punctuation:;',
      'keyword:if',
      'punctuation:(',
      'literal:true',
      'punctuation:)',
      'literal:null',
    ]);
  });

  it('marks the API globals and the members reached through them', () => {
    const tokens = tokenize(`scene.add('cube'); view.frameAll();`);
    const api = tokens.filter((token) => token.kind === 'api');

    expect(api.map((token) => token.text)).toEqual(['scene', 'add', 'view', 'frameAll']);
    expect(api.map((token) => token.entries?.map((entry) => entry.id))).toEqual([
      ['scene'],
      ['scene.add'],
      ['view'],
      ['view.frameAll'],
    ]);
  });

  it('reads a member of a variable as whichever owner has it, settled by the call', () => {
    const [scale] = tokenize('box.scale = 2').filter((token) => token.kind === 'api');
    const [operation] = tokenize('mesh.scale({ scale: 2 })').filter(
      (token) => token.kind === 'api',
    );

    expect(scale.entries?.map((entry) => entry.id)).toEqual(['object.scale']);
    expect(operation.entries?.map((entry) => entry.id)).toEqual(['mesh.scale']);
  });

  it('offers every owner for a name more than one of them has', () => {
    const [remove] = tokenize('thing.delete()').filter((token) => token.kind === 'api');
    expect(remove.entries?.map((entry) => entry.id)).toEqual(['object.delete', 'mesh.delete']);
  });

  it('leaves members the API does not have as plain properties and calls', () => {
    expect(kinds('Math.floor(list.length)')).toEqual([
      'identifier:Math',
      'punctuation:.',
      'function:floor',
      'punctuation:(',
      'identifier:list',
      'punctuation:.',
      'property:length',
      'punctuation:)',
    ]);
  });

  it('does not take an object key named like a namespace for the namespace', () => {
    expect(kinds('({ scene: 1 })')).toContain('identifier:scene');
  });

  it('reads a slash after a value as division and anywhere else as a pattern', () => {
    expect(kinds('a / b')).toEqual(['identifier:a', 'punctuation:/', 'identifier:b']);
    expect(kinds('x = /ab+c/gi')).toEqual(['identifier:x', 'punctuation:=', 'string:/ab+c/gi']);
  });

  it('stops a quoted string at the end of its line and says it never closed', () => {
    const [string] = tokenize(`'open\nnext`).filter((token) => token.kind === 'string');
    expect(string).toMatchObject({ text: "'open", open: true });
  });

  it('keeps every character, in order', () => {
    const source = `const a = scene.add('cube', { size: 2 });\n/* note */\nreturn a;`;
    expect(
      tokenize(source)
        .map((token) => token.text)
        .join(''),
    ).toBe(source);
  });
});

describe('toLines', () => {
  it('cuts tokens that span lines, keeping their kind on each line', () => {
    const lines = toLines(tokenize('/* one\ntwo */ x'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual([{ kind: 'comment', text: '/* one' }]);
    expect(lines[1][0]).toEqual({ kind: 'comment', text: 'two */' });
  });

  it('keeps a line for a trailing line break', () => {
    expect(toLines(tokenize('a\n'))).toHaveLength(2);
  });
});

describe('findImbalance', () => {
  it('is null when every bracket is closed', () => {
    expect(findImbalance('if (a) { b[0] = "}"; }')).toBeNull();
  });

  it('names the bracket left open', () => {
    expect(findImbalance('for (;;) {\n  a();\n')).toEqual({
      line: 1,
      message: 'The { on line 1 is never closed with }',
    });
  });

  it('names a bracket closed by the wrong one', () => {
    expect(findImbalance('call(\n  [1, 2)\n')).toEqual({
      line: 2,
      message: 'Line 2 closes with ), but the [ from line 2 needs ]',
    });
  });

  it('names a closing bracket nothing opened', () => {
    expect(findImbalance('a();\n}')).toEqual({
      line: 2,
      message: 'Line 2 closes a } that was never opened',
    });
  });

  it('names a string that never closes', () => {
    expect(findImbalance(`a = 1;\nb = 'text;`)?.line).toBe(2);
  });
});

describe('completions', () => {
  const at = (source: string) => completionContext(source, source.length);
  const names = (source: string) => {
    const context = at(source);
    return context ? completions(context).map((item) => item.name) : null;
  };

  it('offers the members of a namespace after its dot', () => {
    expect(at('scene.ad')).toEqual({ from: 6, prefix: 'ad', receiver: 'scene' });
    expect(names('scene.ad')).toEqual(['add', 'addMesh']);
  });

  it('offers the globals for a bare word', () => {
    expect(names('sc')).toEqual(['scene']);
  });

  it('offers object, mesh, modifier and material members after any other variable', () => {
    const offered = names('box.addM');
    expect(offered).toEqual(['addModifier', 'addMaterial']);
    expect(names('slot.ind')).toEqual(['index']);
    expect(names('mesh.selectF')).toEqual(['selectFaces', 'selectFaceLoop']);
  });

  it('offers nothing inside a string or a comment', () => {
    expect(at("scene.add('cu")).toBeNull();
    expect(at('// scene.ad')).toBeNull();
  });

  it('offers nothing after the built-in objects', () => {
    expect(names('Math.fl')).toEqual([]);
  });
});
