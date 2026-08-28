import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '../useEditorStore';

describe('panel folds', () => {
  beforeEach(() => {
    useEditorStore.getState().resetScene();
  });

  it('folds and unfolds a panel by title', () => {
    useEditorStore.getState().togglePanel('OUTLINER');
    expect(useEditorStore.getState().collapsedPanels).toEqual({ OUTLINER: true });

    useEditorStore.getState().togglePanel('OUTLINER');
    expect(useEditorStore.getState().collapsedPanels).toEqual({ OUTLINER: false });
  });

  it('rides in the document, but comes back only on a real load', () => {
    useEditorStore.getState().togglePanel('OPERATIONS');
    const document = useEditorStore.getState().snapshotDocument();
    expect(document.panels).toEqual({ OPERATIONS: true });

    // Undo replays the scene through this same format. Restoring the shell with
    // it would refold a panel the user had opened three operations later.
    useEditorStore.getState().setCollapsedPanels({});
    useEditorStore.getState().loadProjectDocument(document);
    expect(useEditorStore.getState().collapsedPanels).toEqual({});

    useEditorStore.getState().loadProjectDocument(document, true);
    expect(useEditorStore.getState().collapsedPanels).toEqual({ OPERATIONS: true });
  });
});

describe('hover hints', () => {
  beforeEach(() => {
    useEditorStore.getState().resetPreferences();
    useEditorStore.setState({ hint: null });
  });

  it('clears any visible hint the moment tooltips are turned off', () => {
    useEditorStore.setState({ hint: { text: 'hi', x: 0, y: 0, anchorTop: 0 } });

    useEditorStore.getState().setPreferences({ tooltipsEnabled: false });

    expect(useEditorStore.getState().hint).toBeNull();
  });

  it('ignores showHint while tooltips are disabled', () => {
    useEditorStore.getState().setPreferences({ tooltipsEnabled: false });

    useEditorStore.getState().showHint('hi', { left: 0, top: 0, bottom: 0 });

    expect(useEditorStore.getState().hint).toBeNull();
  });

  it('shows a hint positioned under the anchor once tooltips are re-enabled', () => {
    useEditorStore.getState().showHint('Extrude', { left: 10, top: 20, bottom: 40 });

    expect(useEditorStore.getState().hint).toEqual({
      text: 'Extrude',
      x: 10,
      y: 40,
      anchorTop: 20,
    });
  });
});

describe('progress on a long operation', () => {
  /** A staged operation whose every step burns `ms` of wall clock. */
  function* slowSteps(ms: number, at: readonly number[]) {
    for (const value of at) {
      const until = performance.now() + ms;
      while (performance.now() < until) {
        /* deliberately blocking, the way a real cut blocks */
      }
      yield value;
    }
    return 'done';
  }

  it('says nothing at all about an operation that finishes quickly', async () => {
    const seen: (number | null)[] = [];
    const stop = useEditorStore.subscribe(
      (state) => state.progress,
      (progress) => seen.push(progress ? progress.value : null),
    );

    const result = await useEditorStore.getState().runStaged('UNION', slowSteps(0, [0.3, 0.6]));
    stop();

    expect(result).toBe('done');
    // Below the threshold nothing is drawn, so a small cut does not make the
    // status bar flicker on its way past.
    expect(seen).toEqual([]);
    expect(useEditorStore.getState().progress).toBeNull();
  });

  it('shows the bar climbing once an operation outlasts the threshold', async () => {
    const seen: number[] = [];
    const stop = useEditorStore.subscribe(
      (state) => state.progress,
      (progress) => {
        if (progress) seen.push(progress.value);
      },
    );

    const result = await useEditorStore
      .getState()
      .runStaged('UNION', slowSteps(90, [0.25, 0.5, 0.75, 1]));
    stop();

    expect(result).toBe('done');
    // The first step or two land inside the threshold; what matters is that the
    // bar appears while there is still work left and moves forwards.
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('is marked busy for the whole run, from the first stage', async () => {
    const store = useEditorStore.getState();
    expect(store.busy).toBe(false);

    // Not awaited yet: this is the window in which a second click could land.
    const running = store.runStaged('UNION', slowSteps(90, [0.5, 1]));
    expect(useEditorStore.getState().busy).toBe(true);

    await running;
    expect(useEditorStore.getState().busy).toBe(false);
  });

  it('clears the bar and the busy flag even when a stage throws', async () => {
    function* fails() {
      yield 0.5;
      throw new Error('cut failed');
    }

    await expect(useEditorStore.getState().runStaged('UNION', fails())).rejects.toThrow(
      'cut failed',
    );
    expect(useEditorStore.getState().progress).toBeNull();
    expect(useEditorStore.getState().busy).toBe(false);
  });

  it('takes the bar down when the operation ends', async () => {
    await useEditorStore.getState().runStaged('REMESH', slowSteps(90, [0.5, 1]));

    expect(useEditorStore.getState().progress).toBeNull();
  });

  it('names the operation, so the bar says what is running', async () => {
    let label: string | null = null;
    const stop = useEditorStore.subscribe(
      (state) => state.progress,
      (progress) => {
        if (progress) label = progress.label;
      },
    );

    await useEditorStore.getState().runStaged('DIFFERENCE', slowSteps(90, [0.5, 1]));
    stop();

    expect(label).toBe('DIFFERENCE');
  });
});
