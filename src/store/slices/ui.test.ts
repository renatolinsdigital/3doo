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
