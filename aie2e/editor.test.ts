import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { type EditorWindow, keepEditorOpen } from './editor';

/** A window with no browser behind it: closing it fires what Playwright fires. */
function fakeWindow() {
  const page = Object.assign(new EventEmitter(), { closed: false, isClosed: () => page.closed });
  const browser = Object.assign(new EventEmitter(), {
    connected: true,
    isConnected: () => browser.connected,
    close: vi.fn(async () => {
      if (!browser.connected) return;
      browser.connected = false;
      page.closed = true;
      page.emit('close');
      browser.emit('disconnected');
    }),
  });
  const window = { page, browser, errors: [] } as unknown as EditorWindow;
  return {
    window,
    /** What a person closing the window does. */
    userCloses: () => void browser.close(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('keepEditorOpen', () => {
  it('opens the window again when the user closes it, and puts the scene back', async () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const open = vi.fn(async () => second.window);
    const restore = vi.fn(async () => {});
    const kept = keepEditorOpen(first.window, open, restore);

    first.userCloses();
    await settle();

    // A closed window used to stay closed for the rest of the run, so the
    // modeller's scenes and the status line had nowhere to show.
    expect(open).toHaveBeenCalledTimes(1);
    expect(kept.current()).toBe(second.window);
    expect(restore).toHaveBeenCalledWith(second.window);
  });

  it('keeps reopening for as long as the user keeps closing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const windows = [fakeWindow(), fakeWindow(), fakeWindow()];
      let next = 1;
      const kept = keepEditorOpen(
        windows[0].window,
        async () => windows[next++].window,
        async () => {},
      );
      for (const index of [0, 1]) {
        vi.setSystemTime(Date.now() + 60_000);
        windows[index].userCloses();
        await settle();
      }
      expect(kept.current()).toBe(windows[2].window);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reopen once the run closes it', async () => {
    const first = fakeWindow();
    const open = vi.fn(async () => fakeWindow().window);
    const kept = keepEditorOpen(first.window, open, async () => {});

    await kept.close();
    await settle();

    expect(open).not.toHaveBeenCalled();
    expect(kept.current()).toBeNull();
  });

  it('gives up on a browser that dies as soon as it opens', async () => {
    const onReopen = vi.fn();
    const open = vi.fn(async () => {
      const dying = fakeWindow();
      setTimeout(dying.userCloses, 0);
      return dying.window;
    });
    const first = fakeWindow();
    const kept = keepEditorOpen(first.window, open, async () => {}, onReopen);
    first.userCloses();
    for (let i = 0; i < 10; i++) await settle();

    expect(open.mock.calls.length).toBeLessThanOrEqual(3);
    expect(onReopen).toHaveBeenLastCalledWith(expect.stringMatching(/closed 3 times/));
    expect(kept.current()).toBeNull();
  });
});
