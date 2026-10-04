import { activeObject, useEditorStore } from '@store/index';

import { createScriptApi } from './api';
import { findImbalance } from './syntax';

/**
 * The name a script runs under, so a stack trace can say which of its frames
 * are the script's own: an error thrown inside the API is reported on the line
 * of the script that called it, not on a line of this file.
 */
export const SCRIPT_URL = '3doo-script.js';

export type ScriptOutcome =
  { ok: true; message: string } | { ok: false; message: string; line: number | null };

type ScriptBody = (scene: unknown, view: unknown) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => ScriptBody;

/**
 * Turns the source into a function of the two globals.
 *
 * Asynchronous so a script can `await scene.boolean(...)`, and strict so a
 * misspelt variable is an error rather than a new global.
 */
function compile(source: string): ScriptBody {
  return new AsyncFunction(
    'scene',
    'view',
    `'use strict';\n${source}\n//# sourceURL=${SCRIPT_URL}`,
  );
}

const FRAME = new RegExp(`${SCRIPT_URL.replace(/[.]/g, '\\.')}:(\\d+)`);

function reportedLine(error: unknown): number | null {
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  const match = FRAME.exec(stack);
  return match ? Number(match[1]) : null;
}

let measuredOffset: Promise<number | null> | null = null;

/**
 * How many lines the engine counts ahead of the script's first one.
 *
 * Every engine wraps the body in a function header of its own, and they do not
 * agree on how many lines it takes, so rather than assume one the offset is
 * measured once, off a body that throws on its first line.
 */
function lineOffset(): Promise<number | null> {
  measuredOffset ??= compile('throw new Error();')(null, null).then(
    () => null,
    (error: unknown) => {
      const line = reportedLine(error);
      return line === null ? null : line - 1;
    },
  );
  return measuredOffset;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function clampLine(line: number | null, source: string): number | null {
  if (line === null) return null;
  const lines = source.split('\n').length;
  return line >= 1 && line <= lines ? line : null;
}

async function errorLine(error: unknown, source: string): Promise<number | null> {
  const reported = reportedLine(error);
  const offset = await lineOffset();
  if (reported === null || offset === null) return null;
  return clampLine(reported - offset, source);
}

/**
 * Where a script that will not compile goes wrong.
 *
 * The engine names a line for a syntax error only sometimes, and never for a
 * body handed to the function constructor in Chrome. The brackets and the
 * quotes are what most often break, so when the engine says nothing, the first
 * one left open or closed twice stands in for it.
 */
async function syntaxProblem(
  error: unknown,
  source: string,
): Promise<{ message: string; line: number | null }> {
  const imbalance = findImbalance(source);
  if (imbalance) return { message: imbalance.message, line: imbalance.line };

  // Firefox puts the line on the error itself, counted the way its stack is.
  const lineNumber = (error as { lineNumber?: unknown }).lineNumber;
  const offset = await lineOffset();
  const line = typeof lineNumber === 'number' && offset !== null ? lineNumber - offset : null;
  return { message: messageOf(error), line: clampLine(line, source) };
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Runs a script against the scene on screen.
 *
 * The whole run is one step to undo. A run that throws, at any line, leaves the
 * scene exactly as it found it: the author fixes the script and runs it again
 * without first having to clear away what the broken run had built.
 */
export async function runScript(source: string): Promise<ScriptOutcome> {
  if (source.trim() === '')
    return { ok: false, message: 'There is nothing to run yet.', line: null };

  let body: ScriptBody;
  try {
    body = compile(source);
  } catch (error) {
    return { ok: false, ...(await syntaxProblem(error, source)) };
  }

  const store = useEditorStore.getState();
  const before = { objects: store.objects, meshVersion: store.meshVersion, cursor: store.cursor };
  const api = createScriptApi();

  let returned: unknown;
  let failure: unknown = null;
  try {
    returned = await store.transact('Run script', () => body(api.scene, api.view));
  } catch (error) {
    failure = error ?? new Error('The script threw nothing to say why.');
  }

  // Edit mode needs an object to edit, and a script is free to delete it.
  const state = useEditorStore.getState();
  if (state.mode === 'edit' && !activeObject(state)) state.setMode('object');

  if (failure !== null) {
    return { ok: false, message: messageOf(failure), line: await errorLine(failure, source) };
  }

  const after = useEditorStore.getState();
  const ids = new Set(before.objects.map((object) => object.id));
  const added = after.objects.filter((object) => !ids.has(object.id)).length;
  const kept = new Set(after.objects.map((object) => object.id));
  const removed = before.objects.filter((object) => !kept.has(object.id)).length;
  const changed =
    after.objects !== before.objects ||
    after.meshVersion !== before.meshVersion ||
    after.cursor !== before.cursor;

  const counts = [
    added > 0 ? `${plural(added, 'object')} added` : '',
    removed > 0 ? `${plural(removed, 'object')} removed` : '',
  ].filter(Boolean);

  const message =
    typeof returned === 'string' && returned.trim() !== ''
      ? returned.trim()
      : counts.length > 0
        ? `Script ran: ${counts.join(', ')}`
        : changed
          ? 'Script ran'
          : 'Script ran, and left the scene as it was';

  useEditorStore.setState({ status: message });
  return { ok: true, message };
}
