import { useEffect } from 'react';

import { type EditorStore, activeObject, useEditorStore } from '@store/index';
import type { PivotMode, SelectMode, ShadingMode } from '@store/types';

import { matchBinding, reloadShortcut } from '../keymap/keymap';

import { useProjectFiles } from './useProjectFiles';

const SHADING_CYCLE: ShadingMode[] = ['solid', 'solidWire', 'wireframe', 'xray', 'matcap'];

/** The order Ctrl+. steps through, which is the order the top bar lists. */
const PIVOT_CYCLE: PivotMode[] = ['origin', 'median', 'cursor'];

/**
 * Which element type X deletes.
 *
 * The operator takes an explicit mode, and the active select mode is the only
 * honest answer to "whatever is selected": picking anything else would delete
 * elements the user cannot currently see highlighted. The Delete key's menu
 * names the type on each entry instead, so it needs no such guess.
 */
const ELEMENT_FOR_SELECT_MODE: Record<SelectMode, 'verts' | 'edges' | 'faces'> = {
  vertex: 'verts',
  edge: 'edges',
  face: 'faces',
};

/** The input types a keystroke belongs to rather than to the keymap. */
const TEXT_INPUT_TYPES = new Set(['text', 'number', 'search', 'email', 'url', 'tel', 'password']);

/**
 * Whether a keystroke is going into a field rather than to the editor.
 *
 * Type-aware rather than tag-aware: a toggle's checkbox keeps focus after it is
 * clicked, and treating that as typing left every shortcut dead: click
 * proportional editing on, and G, R and S did nothing until the next click
 * landed somewhere else.
 */
function isTypingTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((target as HTMLInputElement).type);
}

/** Whether a keyboard rotate or scale has anything to act on: objects, or vertices in edit mode. */
function hasTransformTarget(state: EditorStore): boolean {
  if (state.mode === 'object') return state.selectedObjectIds.length > 0;
  return (activeObject(state)?.mesh.selectedVerts().length ?? 0) > 0;
}

/** Wires the keymap table to store actions. */
export function useKeymap(): void {
  const { saveProject, saveProjectAs, openProject } = useProjectFiles();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const state = useEditorStore.getState();

      // Checked ahead of the typing guard, and ahead of everything else: a
      // refresh throws away whatever is in no file, whatever the keyboard
      // focus was on at the time.
      const reload = reloadShortcut(event);
      // Nothing has changed since the last save, so the reload loses nothing
      // and the browser is left to run it. Not `location.reload()`, which
      // cannot skip the cache the way the hard reloads ask it to.
      if (reload === 'ask' && !state.dirty) return;
      if (reload) {
        event.preventDefault();
        if (reload === 'ask') {
          state.openDialog('reload');
          return;
        }
        // Ctrl+R is the loop cut, which edit mode runs from the keymap below.
        // Object mode has no loop to cut, so the key stops here rather than
        // asking about a reload nobody meant: this is the browser shortcut
        // the editor has taken, not a request to leave.
        if (state.mode === 'object') return;
      }

      // Never steal keys from a field the user is typing in.
      if (isTypingTarget(event.target as HTMLElement | null)) return;

      // Ctrl/Cmd+A never reaches the browser, whether or not it is bound here:
      // its default is "select all page text", which breaks the 3D immersion the
      // moment someone reaches for the wrong modifier. Object mode applies the
      // transform with it; plain "A" still selects all geometry/objects.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
      }

      // A live modal transform owns the keyboard: the viewport listens for its
      // own confirm, cancel and axis keys, and the ordinary bindings would fire
      // operations in the middle of it.
      if (state.modal) return;

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
        // Blender's R and S: the turn or the drag starts on the keypress, with
        // no handle to grab first. The viewport picks the modal up from here.
        case 'rotate':
          state.setActiveTool('rotate');
          if (hasTransformTarget(state)) state.beginModal('rotate');
          break;
        case 'scale':
          state.setActiveTool('scale');
          if (hasTransformTarget(state)) state.beginModal('scale');
          break;

        case 'slide':
          // Every check the slide needs is a question about the selection, so
          // the store answers it and says why when the answer is no.
          state.beginSlide();
          break;

        // All three take their distance from the pointer, the way Blender's do:
        // the store checks the selection can feed one and the viewport runs it.
        case 'extrude':
          state.beginOffset('extrude');
          break;
        case 'inset':
          state.beginOffset('inset');
          break;
        case 'bevel':
          state.beginOffset('bevel');
          break;
        case 'loopCut':
          state.exec('loopCut', { cuts: 1 }, 'Loop cut');
          break;
        // A tool rather than a one-off: the knife stays in hand for the next
        // cut, the way G leaves the move tool there, until another is picked.
        case 'knife':
          state.setActiveTool('knife');
          break;
        case 'subdivide':
          state.exec('subdivide', { cuts: 1 }, 'Subdivide');
          break;
        case 'merge':
          if (state.mode === 'object') state.mergeSelected();
          else state.openDialog('merge');
          break;
        case 'fill':
          state.exec('fill', {}, 'Fill');
          break;
        case 'connect':
          state.exec('connect', {}, 'Connect');
          break;
        case 'bridge':
          state.exec('bridge', {}, 'Bridge');
          break;
        case 'triangulate':
          state.exec('triangulate', {}, 'Triangulate');
          break;
        case 'trisToQuads':
          state.exec('trisToQuads', {}, 'Tris to quads');
          break;

        case 'delete':
          if (state.mode === 'object') state.deleteSelected();
          else {
            state.exec('delete', { mode: ELEMENT_FOR_SELECT_MODE[state.selectMode] }, 'Delete');
          }
          break;
        // A second press closes it, like the shortcut overlay. Reopening would
        // land somewhere else: the pointer is over the menu by then, and the
        // viewport counts that as having left the canvas.
        case 'deleteMenu':
          if (state.deleteMenu) state.closeDeleteMenu();
          else state.openDeleteMenuAtPointer();
          break;
        case 'duplicate':
          if (state.mode === 'object') state.duplicateSelected(false);
          break;
        case 'linkedDuplicate':
          if (state.mode === 'object') state.duplicateSelected(true);
          break;
        case 'separate':
          if (state.mode === 'object') state.separateLooseParts();
          break;
        case 'group':
          if (state.mode === 'object') state.groupSelected();
          break;
        case 'applyTransform':
          if (state.mode === 'object') state.applyTransformToSelected();
          break;
        case 'recalculateNormals':
          state.exec('recalculateNormals', { outside: true }, 'Recalculate normals');
          break;
        case 'undo':
          state.undo();
          break;
        case 'redo':
          state.redo();
          break;

        case 'selectTool':
          state.cycleSelectShape();
          break;
        case 'clearSelection':
          state.clearSelection();
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
        case 'selectFaceLoop':
          state.exec('selectFaceLoop', {}, 'Select face loop');
          break;
        case 'growSelection':
          state.exec('growSelection', {}, 'Grow selection');
          break;
        case 'shrinkSelection':
          state.exec('shrinkSelection', {}, 'Shrink selection');
          break;

        // The four snaps need a raycast at the pointer, which only the viewport
        // can run: it answers the request and reports what it found.
        case 'cursorToPointer':
          state.snapCursorUnderPointer('point');
          break;
        case 'cursorToVertex':
          state.snapCursorUnderPointer('vertex');
          break;
        case 'cursorToEdge':
          state.snapCursorUnderPointer('edge');
          break;
        case 'cursorToFace':
          state.snapCursorUnderPointer('face');
          break;
        case 'cursorToWorldOrigin':
          state.setCursor({ x: 0, y: 0, z: 0 }, 'Cursor to world origin');
          break;
        case 'cursorToSelection':
          state.cursorToSelection();
          break;
        case 'cursorToSelectionOrigin':
          state.cursorToSelectionOrigin();
          break;
        case 'selectionToCursor':
          state.selectionToCursor();
          break;
        case 'originToCursor':
          state.originToCursor();
          break;
        case 'toggleCursor':
          state.setOverlay({ cursor: !state.overlays.cursor });
          break;
        case 'togglePivot':
          state.setPivot(PIVOT_CYCLE[(PIVOT_CYCLE.indexOf(state.pivot) + 1) % PIVOT_CYCLE.length]);
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
        case 'viewTop':
          state.setAxisView('y');
          break;
        case 'viewBottom':
          state.setAxisView('y', true);
          break;
        case 'viewLeft':
          state.setAxisView('x', true);
          break;
        case 'viewRight':
          state.setAxisView('x');
          break;
        case 'viewFront':
          state.setAxisView('z');
          break;
        case 'viewBack':
          state.setAxisView('z', true);
          break;
        case 'orbitUp':
          state.orbitView('up');
          break;
        case 'orbitDown':
          state.orbitView('down');
          break;
        case 'orbitLeft':
          state.orbitView('left');
          break;
        case 'orbitRight':
          state.orbitView('right');
          break;
        case 'orbitOpposite':
          state.orbitView('opposite');
          break;
        case 'toggleWireframe': {
          const next =
            SHADING_CYCLE[(SHADING_CYCLE.indexOf(state.shading) + 1) % SHADING_CYCLE.length];
          state.setShading(next);
          break;
        }

        case 'save':
          void saveProject();
          break;
        case 'saveAs':
          void saveProjectAs();
          break;
        case 'open':
          // Through the same prompt the menu goes through: the shortcut is a
          // faster route to the action, not a way around what it costs.
          if (state.savedToFile) void openProject();
          else state.openDialog('openProject');
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
  }, [openProject, saveProject, saveProjectAs]);
}
