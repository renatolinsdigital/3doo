import { type ApiEntry, NAMESPACES, apiEntry, memberEntries, membersOf } from './reference';

export type TokenKind =
  | 'keyword'
  | 'literal'
  | 'number'
  | 'string'
  | 'comment'
  | 'api'
  | 'function'
  | 'property'
  | 'identifier'
  | 'punctuation'
  | 'space';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Offset of its first character in the source. */
  start: number;
  /** For an API name: every entry it may stand for. */
  entries?: readonly ApiEntry[];
  /** A string or a comment the source ends, or the line ends, before closing. */
  open?: boolean;
}

const KEYWORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'extends',
  'finally',
  'for',
  'function',
  'if',
  'in',
  'instanceof',
  'let',
  'new',
  'of',
  'return',
  'static',
  'super',
  'switch',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'yield',
]);

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this']);

/** Keywords after which a slash opens a regular expression rather than dividing. */
const BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'void',
  'yield',
  'await',
  'throw',
  'delete',
]);

const NUMBER =
  /^(?:0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/;
const IDENTIFIER_START = /[A-Za-z_$À-￿]/;
const IDENTIFIER_PART = /[\w$À-￿]/;

/**
 * Splits a script into tokens for the editor to colour.
 *
 * Hand-written rather than a parser: it has to keep going through code that is
 * half typed, which is every keystroke, and all it needs to decide is what
 * colour each run of characters is and which API name, if any, it is.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let significant: Token | null = null;
  let beforeSignificant: Token | null = null;

  const push = (kind: TokenKind, end: number, extra: Partial<Token> = {}) => {
    const token: Token = { kind, text: source.slice(i, end), start: i, ...extra };
    tokens.push(token);
    if (kind !== 'space' && kind !== 'comment') {
      beforeSignificant = significant;
      significant = token;
    }
    i = end;
  };

  const nextSignificant = (from: number) => {
    let at = from;
    while (at < source.length && /\s/.test(source[at])) at++;
    return source[at];
  };

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (/\s/.test(char)) {
      let end = i + 1;
      while (end < source.length && /\s/.test(source[end])) end++;
      push('space', end);
      continue;
    }

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      push('comment', end === -1 ? source.length : end);
      continue;
    }

    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      push('comment', close === -1 ? source.length : close + 2, close === -1 ? { open: true } : {});
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      let end = i + 1;
      let closed = false;
      while (end < source.length) {
        const c = source[end];
        if (c === '\\') {
          end += 2;
          continue;
        }
        if (c === char) {
          end++;
          closed = true;
          break;
        }
        // A quoted string stops at the end of its line; a template runs on.
        if (c === '\n' && char !== '`') break;
        end++;
      }
      push('string', Math.min(end, source.length), closed ? {} : { open: true });
      continue;
    }

    const number = /[\d.]/.test(char) ? NUMBER.exec(source.slice(i)) : null;
    if (number && number[0] !== '.' && (char !== '.' || /\d/.test(next ?? ''))) {
      push('number', i + number[0].length);
      continue;
    }

    if (IDENTIFIER_START.test(char)) {
      let end = i + 1;
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end++;
      const name = source.slice(i, end);
      const called = nextSignificant(end) === '(';
      const previous = significant as Token | null;
      const member = previous?.kind === 'punctuation' && previous.text === '.';

      if (member) {
        const receiver = beforeSignificant as Token | null;
        const owner =
          receiver && (receiver.kind === 'identifier' || receiver.kind === 'api')
            ? receiver.text
            : '';
        const entries = memberEntries(owner, name, called);
        if (entries.length > 0) push('api', end, { entries });
        else push(called ? 'function' : 'property', end);
      } else if (KEYWORDS.has(name)) {
        push('keyword', end);
      } else if (LITERALS.has(name)) {
        push('literal', end);
      } else if (NAMESPACES.has(name) && source[end] !== ':') {
        const entry = apiEntry(name);
        push('api', end, entry ? { entries: [entry] } : {});
      } else {
        push(called ? 'function' : 'identifier', end);
      }
      continue;
    }

    if (char === '/') {
      const previous = significant as Token | null;
      const expression =
        !previous ||
        (previous.kind === 'punctuation' && !/[)\]}]/.test(previous.text)) ||
        (previous.kind === 'keyword' && BEFORE_EXPRESSION.has(previous.text));
      if (expression) {
        const end = regexEnd(source, i);
        if (end !== null) {
          push('string', end);
          continue;
        }
      }
    }

    push('punctuation', i + 1);
  }

  return tokens;
}

/** Where a regular expression starting at `start` ends, or null when the line ends first. */
function regexEnd(source: string, start: number): number | null {
  let end = start + 1;
  let inClass = false;
  while (end < source.length) {
    const c = source[end];
    if (c === '\n') return null;
    if (c === '\\') {
      end += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      end++;
      while (end < source.length && /[a-z]/i.test(source[end])) end++;
      return end;
    }
    end++;
  }
  return null;
}

export type LineToken = Omit<Token, 'start'>;

/** The tokens cut at every line break, one list per line of the source. */
export function toLines(tokens: readonly Token[]): LineToken[][] {
  const lines: LineToken[][] = [[]];
  for (const { start, ...token } of tokens) {
    void start;
    const pieces = token.text.split('\n');
    pieces.forEach((piece, index) => {
      if (index > 0) lines.push([]);
      if (piece !== '') lines[lines.length - 1].push({ ...token, text: piece });
    });
  }
  return lines;
}

/** The 1-based line an offset falls on. */
export function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

export interface Imbalance {
  line: number;
  message: string;
}

/**
 * The first bracket left open or closed twice, or a string never closed.
 *
 * What most often stops a script compiling, and what the engine is worst at
 * pointing to: a missing `}` is reported, when it is reported at all, on the
 * last line, while the brace that needed it is somewhere far above.
 */
export function findImbalance(source: string): Imbalance | null {
  const open: { char: string; line: number }[] = [];

  for (const token of tokenize(source)) {
    const line = lineAt(source, token.start);
    if (token.open && token.kind === 'string') {
      return {
        line,
        message: `The text started on line ${line} is never closed with ${token.text[0]}`,
      };
    }
    if (token.open && token.kind === 'comment') {
      return { line, message: `The comment started on line ${line} is never closed with */` };
    }
    if (token.kind !== 'punctuation') continue;

    if (PAIRS[token.text]) {
      open.push({ char: token.text, line });
    } else if (CLOSERS[token.text]) {
      const last = open.pop();
      if (!last)
        return { line, message: `Line ${line} closes a ${token.text} that was never opened` };
      if (last.char !== CLOSERS[token.text]) {
        return {
          line,
          message: `Line ${line} closes with ${token.text}, but the ${last.char} from line ${last.line} needs ${PAIRS[last.char]}`,
        };
      }
    }
  }

  const unclosed = open.pop();
  if (unclosed) {
    return {
      line: unclosed.line,
      message: `The ${unclosed.char} on line ${unclosed.line} is never closed with ${PAIRS[unclosed.char]}`,
    };
  }
  return null;
}

/** What the caret is in the middle of typing, for the completion list. */
export interface CompletionContext {
  /** Where the word being typed starts. */
  from: number;
  prefix: string;
  /** The name before the dot, `''` after a call or an index, null with no dot. */
  receiver: string | null;
}

export function completionContext(source: string, caret: number): CompletionContext | null {
  let from = caret;
  while (from > 0 && IDENTIFIER_PART.test(source[from - 1])) from--;
  const prefix = source.slice(from, caret);
  if (prefix !== '' && !IDENTIFIER_START.test(prefix[0])) return null;

  // Nothing is offered inside a string or a comment. Right after one that has
  // closed is outside it; at the end of one still open, or of a line comment,
  // is not.
  const inside = tokenize(source).find((token) => {
    if (token.kind !== 'string' && token.kind !== 'comment') return false;
    const end = token.start + token.text.length;
    if (token.start >= caret || caret > end) return false;
    return caret < end || token.open || token.text.startsWith('//');
  });
  if (inside) return null;

  if (source[from - 1] !== '.') return { from, prefix, receiver: null };

  const end = from - 1;
  let start = end;
  while (start > 0 && IDENTIFIER_PART.test(source[start - 1])) start--;
  const receiver = source.slice(start, end);
  return {
    from,
    prefix,
    receiver: receiver !== '' && IDENTIFIER_START.test(receiver[0]) ? receiver : '',
  };
}

/** One name the completion list offers, with every entry it stands for. */
export interface Completion {
  name: string;
  entries: readonly ApiEntry[];
}

/** Receivers that are plainly not the API, after which nothing is offered. */
const FOREIGN = new Set([
  'Math',
  'console',
  'JSON',
  'Object',
  'Array',
  'Number',
  'String',
  'Promise',
  'window',
  'document',
]);

export function completions(context: CompletionContext): Completion[] {
  if (context.receiver !== null && FOREIGN.has(context.receiver)) return [];

  const pool =
    context.receiver === null
      ? [...NAMESPACES].map((name) => apiEntry(name)).filter((entry): entry is ApiEntry => !!entry)
      : membersOf(context.receiver);

  const grouped = new Map<string, ApiEntry[]>();
  for (const entry of pool) grouped.set(entry.name, [...(grouped.get(entry.name) ?? []), entry]);

  const prefix = context.prefix.toLowerCase();
  const all = [...grouped].map(([name, entries]) => ({ name, entries }));
  const leading = all.filter((item) => item.name.toLowerCase().startsWith(prefix));
  const within = all.filter(
    (item) =>
      !item.name.toLowerCase().startsWith(prefix) && item.name.toLowerCase().includes(prefix),
  );
  return [...leading, ...within].filter((item) => item.name !== context.prefix);
}
