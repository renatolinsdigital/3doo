import { useEffect } from 'react';

import { useEditorStore } from '@store/index';
import type { SelectMode, ShadingMode } from '@store/types';

import { matchBinding } from '../keymap/keymap';

import { useProjectFiles } from './useProjectFiles';

const SHADING_CYCLE: ShadingMode[] = ['solid', 'solidWire', 'wireframe', 'xray', 'matcap'];

/**
 * Which element type X (delete) and Delete (dissolve) act on.
 *
 * Both operators take an explicit mode, and the active select mode is the only
 * honest answer to "whatever is selected" — picking anything else would delete
 * elements the user cannot currently see highlighted.
 */
const ELEMENT_FOR_SELECT_MODE: Record<SelectMode, 'verts' | 'edges' | 'faces'> = {
  vertex: 'verts',
  edge: 'edges',
  face: 'faces',
};

/** Wires the keymap table to store actions. */
export function useKeymap(): void {
  const { saveProject, openProject } = useProjectFiles();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from a field the user is typing in.
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      // Ctrl/Cmd+A is deliberately a no-op over the viewport: the browser
      // default is "select all page text", which breaks the 3D immersion the
      // moment someone reaches for the wrong modifier. Plain "A" still selects
      // all geometry/objects below.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        return;
      }

      const state = useEditorStore.getState();
      const binding = matchBinding(event, state.mode);
      if (!binding) return;

      event.preventDefault();

      switch (binding.id) {
        case 'toggleMode':
          state.toggleMode();
          break;
        case 'selectVertex':
          state.setSelectMode('vertex');
          break;
        case 'selectEdge':
          state.setSelectMode('edge');
          break;
        case 'selectFace':
          state.setSelectMode('face');
          break;

        case 'move':
          state.setActiveTool('move');
          break;
        case 'rotate':
          state.setActiveTool('rotate');
          break;
        case 'scale':
          state.setActiveTool('scale');
          break;

        case 'extrude':
          state.exec('extrude', { offset: 1 }, 'Extrude');
          break;
        case 'inset':
          state.exec('inset', { thickness: 0.2 }, 'Inset');
          break;
        case 'bevel':
          state.exec('bevel', { width: 0.2, segments: 1 }, 'Bevel');
          break;
        case 'loopCut':
          state.exec('loopCut', { cuts: 1 }, 'Loop cut');
          break;
        case 'subdivide':
          state.exec('subdivide', { cuts: 1 }, 'Subdivide');
          break;
        case 'merge':
          state.openDialog('merge');
          break;
        case 'fill':
          state.exec('fill', {}, 'Fill');
          break;
        case 'connect':
          state.exec('connect', {}, 'Connect');
          break;

        case 'delete':
          if (state.mode === 'object') state.deleteSelected();
          else {
            state.exec('delete', { mode: ELEMENT_FOR_SELECT_MODE[state.selectMode] }, 'Delete');
          }
          break;
        case 'dissolve':
          if (state.mode === 'object') state.deleteSelected();
          else {
            state.exec('dissolve', { mode: ELEMENT_FOR_SELECT_MODE[state.selectMode] }, 'Dissolve');
          }
          break;
        case 'duplicate':
          if (state.mode === 'object') state.duplicateSelected(false);
          break;
        case 'undo':
          state.undo();
          break;
        case 'redo':
          state.redo();
          break;

        case 'selectAll':
          if (state.mode === 'edit') state.exec('selectAll', {}, 'Select all');
          else state.selectAllObjects();
          break;
        case 'deselectAll':
          if (state.mode === 'edit') state.exec('deselectAll', {}, 'Deselect all');
          else state.setActiveObject(null);
          break;
        case 'invertSelection':
          if (state.mode === 'edit') state.exec('invertSelection', {}, 'Invert selection');
          break;

        case 'frameSelected':
          state.frameSelected();
          break;
        case 'frameAll':
          state.frameAll();
          break;
        case 'toggleOrtho':
          state.setViewportSetting({ orthographic: !state.orthographic });
          break;
        case 'viewFront':
          state.setAxisView('z');
          break;
        case 'viewSide':
          state.setAxisView('x');
          break;
        case 'viewTop':
          state.setAxisView('y');
          break;
        case 'toggleWireframe': {
          const next = SHADING_CYCLE[(SHADING_CYCLE.indexOf(state.shading) + 1) % SHADING_CYCLE.length];
          state.setShading(next);
          break;
        }

        case 'save':
          saveProject();
          break;
        case 'open':
          void openProject();
          break;
        case 'export':
          state.openDialog('export');
          break;
        case 'shortcuts':
          state.openDialog(state.dialog === 'shortcuts' ? null : 'shortcuts');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openProject, saveProject]);
}
