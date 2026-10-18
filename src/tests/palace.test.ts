import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Keeps the AI memory palace honest (see `docs/ai-memory.md`).
 *
 * The rooms in `.claude/rules` name code and files so an assistant can go
 * straight to them instead of reading the codebase, and it trusts what they
 * say. A rename or a removal leaves a room pointing at nothing: the ACTIONS
 * log's `recorder.ts` outlived the file by a week in the first draft. These
 * fail the suite instead.
 */

// Under jsdom `import.meta.url` is not a file URL; Vitest runs from the root.
const ROOT = process.cwd();
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git']);

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const FILES = walk('');
const ROOMS = FILES.filter((file) => /^\.claude\/rules\/(palace|room-[\w-]+)\.md$/.test(file));
const SOURCE = FILES.filter((file) => /^(src|mcp|gpu|aie2e)\/.*\.tsx?$/.test(file))
  .map((file) => readFileSync(join(ROOT, file), 'utf8'))
  .join('\n');

/** Everything a room puts in backticks, with the room it came from. */
function quoted(): { room: string; token: string }[] {
  return ROOMS.flatMap((room) =>
    [...readFileSync(join(ROOT, room), 'utf8').matchAll(/`([^`\n]+)`/g)].map((match) => ({
      room,
      token: match[1],
    })),
  );
}

/** A file or folder: has a slash or a file extension, and no spaces or calls. */
function isPath(token: string): boolean {
  if (/[\s()<>]/.test(token) || token.startsWith('.')) return false;
  return token.includes('/') || /\.(tsx?|md|mjs|json)$/.test(token);
}

/** Written relative to the room's own area, so matched as a suffix. */
function exists(path: string): boolean {
  const target = path.replace(/\/$/, '');
  return FILES.some(
    (file) =>
      file === target ||
      file.endsWith(`/${target}`) ||
      file.startsWith(`${target}/`) ||
      file.includes(`/${target}/`),
  );
}

/**
 * A name worth checking: camelCase, PascalCase or a CONSTANT. Plain words in
 * backticks (`dirty`, `frame`, `ok`) are prose, not pointers into the code.
 */
function identifier(token: string): string | null {
  const name = token.replace(/\(.*\)$/, '');
  return /^[A-Za-z_]\w*$/.test(name) && name.length >= 4 && /[A-Z_]/.test(name) ? name : null;
}

describe('the AI memory palace', () => {
  it('has its map and its rooms', () => {
    expect(ROOMS).toContain('.claude/rules/palace.md');
    expect(ROOMS.length).toBeGreaterThan(1);
  });

  it('points only at files and folders that exist', () => {
    const missing = quoted().filter(({ token }) => isPath(token) && !exists(token));
    expect(missing).toEqual([]);
  });

  it('names only identifiers the code still has', () => {
    const missing = quoted().filter(({ token }) => {
      const name = identifier(token);
      return name !== null && !new RegExp(`\\b${name}\\b`).test(SOURCE);
    });
    expect(missing).toEqual([]);
  });
});
