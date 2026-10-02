import { type ContextMenuEntry, ContextMenu } from '@shared/components';
import { useDeleteActions, useEditorStore } from '@store/index';

type Element = 'verts' | 'edges' | 'faces';

const NOUN: Record<Element, string> = { verts: 'vertices', edges: 'edges', faces: 'faces' };

/**
 * The menu the Delete key opens in edit mode.
 *
 * Every entry names the element type it acts on, so unlike X it does not read
 * the select mode: with a face selected in vertex select, DELETE FACES still
 * takes the face. Entries with nothing to act on are disabled rather than
 * dropped, and their hint says what they are waiting for.
 */
export function DeleteMenu() {
  const menu = useEditorStore((state) => state.deleteMenu);
  const close = useEditorStore((state) => state.closeDeleteMenu);
  const exec = useEditorStore((state) => state.exec);
  const can = useDeleteActions();

  if (!menu) return null;

  const remove = (element: Element, label: string, ready: string): ContextMenuEntry => {
    const count = can[element];
    return {
      id: `delete-${element}`,
      label,
      disabled: count === 0,
      hint: count > 0 ? ready : `No ${NOUN[element]} selected to delete`,
      onSelect: () => exec('delete', { mode: element }, `Delete ${NOUN[element]}`),
    };
  };

  /** `refusal` is why a selection of this type still cannot dissolve, or null when it can. */
  const dissolve = (
    element: Element,
    label: string,
    ready: string,
    refusal: string | null,
  ): ContextMenuEntry => {
    const why = can[element] === 0 ? `No ${NOUN[element]} selected to dissolve` : refusal;
    return {
      id: `dissolve-${element}`,
      label,
      disabled: why !== null,
      hint: why ?? ready,
      onSelect: () => exec('dissolve', { mode: element }, `Dissolve ${NOUN[element]}`),
    };
  };

  const entries: ContextMenuEntry[] = [
    remove(
      'verts',
      'DELETE VERTICES',
      'Remove the selected vertices along with every edge and face using them, leaving a hole',
    ),
    remove(
      'edges',
      'DELETE EDGES',
      'Remove the selected edges along with the faces on them, leaving a hole',
    ),
    remove(
      'faces',
      'DELETE FACES',
      'Remove the selected faces, and any edge or vertex that only they were using',
    ),
    { id: 'rule', separator: true },
    dissolve(
      'verts',
      'DISSOLVE VERTICES',
      'Remove the selected vertices and merge the faces around each one, keeping the surface closed. A corner whose faces meet at more than 40° is left alone',
      can.flatVert
        ? null
        : 'Every selected vertex is a corner whose faces meet at more than 40°, too sharp to merge into one face',
    ),
    dissolve(
      'edges',
      'DISSOLVE EDGES',
      'Remove the selected edges and merge the faces on either side, keeping the surface closed. An edge whose faces meet at more than 40° is left alone',
      !can.innerEdge
        ? 'Only an edge with a face on each side can dissolve, and the selected ones all lie on an open border'
        : can.flatEdge
          ? null
          : 'Every selected edge joins faces that meet at more than 40°, too sharp to merge into one face',
    ),
    dissolve(
      'faces',
      'DISSOLVE FACES',
      'Merge the selected faces into one face',
      !can.touchingFaces
        ? 'Select two or more faces that share an edge to merge them into one'
        : can.openFaces
          ? null
          : 'The selected faces close off a solid, leaving no outline to merge them into',
    ),
  ];

  return (
    <ContextMenu x={menu.x} y={menu.y} label="DELETE MENU" entries={entries} onClose={close} />
  );
}
