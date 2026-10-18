import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Browser, type Page, chromium } from 'playwright-core';

import type { SceneSummary } from '../src/app/automation/types.ts';

/**
 * The editor in a window of its own, on the machine's GPU: first the smoke
 * test clicks through the main functions, then it shows the agents' scene,
 * reloaded after every script the modeller runs.
 */

export interface EditorWindow {
  browser: Browser;
  page: Page;
  /** Errors the page threw, which the smoke test counts as failures. */
  errors: string[];
}

/** WebGL from the CPU, for a run with no window and maybe no GPU. */
const SOFTWARE_GL = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

export async function openEditor(url: string, headless: boolean): Promise<EditorWindow> {
  const args = headless ? SOFTWARE_GL : [];
  let browser: Browser | null = null;
  const failures: string[] = [];
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      browser = await chromium.launch({ channel, headless, args });
      break;
    } catch (error) {
      failures.push((error as Error).message.split('\n')[0]);
    }
  }
  if (!browser) throw new Error(`No browser to show the editor in. (${failures[0]})`);

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  // Saving asks the browser for a file picker where it has one, which a
  // driven browser cannot answer; without it the app downloads instead.
  await context.addInitScript(() => {
    try {
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined });
    } catch {
      // Left as it is: the export dialog downloads either way.
    }
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await goToEditor(page, url);
  return { browser, page, errors };
}

export interface KeptEditor {
  /** The window as it stands, or null while a new one opens or none could. */
  current(): EditorWindow | null;
  /** Closes the window for good: nothing reopens it after this. */
  close(): Promise<void>;
}

/** Windows lost this soon after opening count as a crash, not as a person closing them. */
const QUICK_LOSS_MS = 3000;
const QUICK_LOSSES = 3;

/**
 * Keeps the editor window up for the whole run. A window the user closes, or
 * a browser that goes away, is opened again, and `restore` puts back what the
 * old one showed. Before this a closed window stayed closed, and every scene
 * the agents made after it went unseen.
 */
export function keepEditorOpen(
  first: EditorWindow | null,
  open: () => Promise<EditorWindow>,
  restore: (editor: EditorWindow) => Promise<void>,
  onReopen: (failure: string | null) => void = () => {},
): KeptEditor {
  let window: EditorWindow | null = null;
  let closed = false;
  let quickLosses = 0;

  const reopen = async () => {
    if (quickLosses >= QUICK_LOSSES) {
      onReopen(`the window closed ${QUICK_LOSSES} times as soon as it opened`);
      return;
    }
    let next: EditorWindow;
    try {
      next = await open();
    } catch (error) {
      onReopen((error as Error).message.split('\n')[0]);
      return;
    }
    if (closed) {
      await next.browser.close().catch(() => {});
      return;
    }
    onReopen(null);
    watch(next);
    await restore(next).catch(() => {});
  };

  const watch = (editor: EditorWindow) => {
    window = editor;
    const opened = Date.now();
    let lost = false;
    const lose = () => {
      if (lost) return;
      lost = true;
      if (window === editor) window = null;
      void editor.browser.close().catch(() => {});
      if (closed) return;
      quickLosses = Date.now() - opened < QUICK_LOSS_MS ? quickLosses + 1 : 0;
      void reopen();
    };
    editor.page.once('close', lose);
    editor.browser.once('disconnected', lose);
    if (editor.page.isClosed() || !editor.browser.isConnected()) lose();
  };

  if (first) watch(first);
  return {
    current: () => window,
    close: async () => {
      closed = true;
      const last = window;
      window = null;
      await last?.browser.close().catch(() => {});
    },
  };
}

async function goToEditor(page: Page, url: string): Promise<void> {
  await page.goto(new URL('/modeling', url).href, { waitUntil: 'load' });
  await page.waitForFunction(() => window.threedoo !== undefined, null, { timeout: 30_000 });
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 30_000 });
}

const scene = (page: Page): Promise<SceneSummary> =>
  page.evaluate(() => (window.threedoo as NonNullable<typeof window.threedoo>).scene());

/** Keys go to the window, not to whatever control a click left focused. */
async function press(page: Page, key: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
}

const facesOf = (summary: SceneSummary, name: string) =>
  summary.objects.find((object) => object.name === name)?.faces ?? -1;

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

/**
 * The editor's main functions, driven the way a person drives them: panel
 * buttons, keys and dialogs. Each step says what it saw. A step that fails
 * does not stop the others, so one broken function does not hide the rest.
 */
export async function runSmoke(
  editor: EditorWindow,
  url: string,
  dir: string,
): Promise<SmokeStep[]> {
  const { page } = editor;
  const steps: SmokeStep[] = [];
  const step = async (name: string, work: () => Promise<string>) => {
    const started = Date.now();
    try {
      const detail = await work();
      steps.push({ name, ok: true, detail, ms: Date.now() - started });
    } catch (error) {
      steps.push({
        name,
        ok: false,
        detail: (error as Error).message.split('\n')[0],
        ms: Date.now() - started,
      });
    }
  };
  const check = (condition: boolean, failure: string) => {
    if (!condition) throw new Error(failure);
  };
  const button = (label: string) => page.getByRole('button', { name: label, exact: true });

  let cube = '';
  let cylinder = '';

  await step('Opens on the starting cube', async () => {
    const summary = await scene(page);
    check(summary.objects.length === 1, `expected one object, found ${summary.objects.length}`);
    cube = summary.objects[0].name;
    check(summary.objects[0].faces === 6, `the cube has ${summary.objects[0].faces} faces`);
    return `${cube}, 6 faces`;
  });

  await step('Draws the viewport', async () => {
    const shot = await page.locator('canvas').first().screenshot();
    await writeFile(join(dir, 'viewport.png'), shot);
    // A blank or single-colour canvas compresses to almost nothing.
    check(shot.length > 6000, `the viewport picture is ${shot.length} bytes, which looks blank`);
    return `${Math.round(shot.length / 1024)} KB picture`;
  });

  await step('Adds a primitive from the PRIMITIVES panel', async () => {
    await button('CYLINDER').click();
    const summary = await scene(page);
    check(summary.objects.length === 2, `expected two objects, found ${summary.objects.length}`);
    cylinder = summary.objects[1].name;
    return `added ${cylinder}`;
  });

  await step('Undoes and redoes with Ctrl+Z and Ctrl+Shift+Z', async () => {
    await press(page, 'Control+z');
    const undone = (await scene(page)).objects.length;
    check(undone === 1, `after undo there are ${undone} objects`);
    await press(page, 'Control+Shift+z');
    const redone = (await scene(page)).objects.length;
    check(redone === 2, `after redo there are ${redone} objects`);
    return 'two objects, one, then two again';
  });

  await step('Picks an object in the outliner and extrudes its faces in edit mode', async () => {
    await page.locator('.outliner__name', { hasText: cube }).first().click();
    await press(page, 'Tab');
    await press(page, '3');
    await press(page, 'a');
    await page.locator('label', { hasText: 'INDIVIDUAL' }).first().click();
    await button('EXTRUDE').click();
    await page.waitForTimeout(200);
    const faces = facesOf(await scene(page), cube);
    check(faces > 6, `${cube} still has ${faces} faces`);
    return `${cube} went from 6 to ${faces} faces`;
  });

  await step('Bevels the selected edges', async () => {
    const before = facesOf(await scene(page), cube);
    await press(page, '2');
    await press(page, 'a');
    await button('BEVEL').click();
    await page.waitForTimeout(200);
    const after = facesOf(await scene(page), cube);
    check(after > before, `${cube} stayed at ${after} faces`);
    return `${before} to ${after} faces`;
  });

  await step('Returns to object mode and adds a modifier', async () => {
    await press(page, 'Tab');
    await page.getByLabel('Add modifier').selectOption('subdivide');
    await page.waitForTimeout(200);
    const object = (await scene(page)).objects.find((candidate) => candidate.name === cube);
    check(
      !!object?.modifiers.includes('subdivide'),
      `${cube} has modifiers ${object?.modifiers.join(', ') || 'none'}`,
    );
    return `${cube} carries ${object?.modifiers.join(', ')}`;
  });

  await step('Changes shading and views from the keyboard', async () => {
    for (const key of ['Shift+z', 'Shift+1', 'Shift+3', '5', 'Home']) await press(page, key);
    check(editor.errors.length === 0, `the page threw: ${editor.errors[0]}`);
    return 'Shift+Z, Shift+1, Shift+3, 5 and Home';
  });

  await step('Exports FBX and OBJ from the EXPORT dialog', async () => {
    const sizes: string[] = [];
    for (const format of ['FBX', 'OBJ']) {
      await press(page, 'Control+e');
      const download = page.waitForEvent('download', { timeout: 15_000 });
      await button(`EXPORT ${format}`).click();
      const file = await download;
      const path = join(dir, file.suggestedFilename());
      await file.saveAs(path);
      const { size } = await stat(path);
      check(size > 200, `the ${format} file is ${size} bytes`);
      sizes.push(`${file.suggestedFilename()} ${Math.round(size / 1024)} KB`);
    }
    return sizes.join(', ');
  });

  await step('Deletes an object with X', async () => {
    await page.locator('.outliner__name', { hasText: cylinder }).first().click();
    await press(page, 'x');
    const summary = await scene(page);
    check(
      !summary.objects.some((object) => object.name === cylinder),
      `${cylinder} is still in the scene`,
    );
    return `${cylinder} removed`;
  });

  await step('Throws no errors in the page', async () => {
    check(editor.errors.length === 0, editor.errors.slice(0, 3).join(' | '));
    return 'none';
  });

  await page.screenshot({ path: join(dir, 'smoke.png') });
  // Start the agents' part on a fresh editor, not on what the steps left.
  await goToEditor(page, url);
  return steps;
}

/** Puts the agents' scene in the window and frames it. */
export async function showScene(
  editor: EditorWindow,
  project: { name: string; base64: string },
): Promise<void> {
  await editor.page.evaluate(
    (file) => (window.threedoo as NonNullable<typeof window.threedoo>).open(file),
    project,
  );
  await press(editor.page, 'Home');
}

/** A strip across the top of the window saying who is working on what. */
export async function showStatus(editor: EditorWindow, text: string): Promise<void> {
  await editor.page
    .evaluate((line) => {
      let strip = document.getElementById('aie2e-status');
      if (!strip) {
        strip = document.createElement('div');
        strip.id = 'aie2e-status';
        strip.style.cssText =
          'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:99999;padding:6px 14px;font:700 12px/1.4 Consolas,monospace;letter-spacing:.08em;color:#f4f1ea;background:#0b0b0b;border:2px solid #e5342a;box-shadow:4px 4px 0 #e5342a;pointer-events:none;max-width:80vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        document.body.appendChild(strip);
      }
      strip.textContent = line;
    }, text)
    .catch(() => {});
}
