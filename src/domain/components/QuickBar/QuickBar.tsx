import type { ReactNode } from 'react';

import { Button, IconButton } from '@shared/components';
import { useEditorStore } from '@store/index';

import './QuickBar.scss';

/** The ids of the two panel columns, which the drawer buttons name as what they open. */
export const TOOLS_DRAWER_ID = 'modeling-tools';
export const SCENE_DRAWER_ID = 'modeling-scene';

export interface QuickBarProps {
  /**
   * Whether the panel columns are drawers, which they are on a screen too
   * narrow to keep them open beside the viewport. Shows the two buttons that
   * open them.
   */
  drawers: boolean;
  /**
   * Whether a finger is the main way in. Shows what a keyboard would otherwise
   * do: undo and redo, building a selection without Shift, deleting, and
   * finishing a knife cut.
   */
  touch: boolean;
  toolsOpen: boolean;
  sceneOpen: boolean;
  /** Whether each column has any panel to show; one with none gets no button. */
  hasTools: boolean;
  hasScene: boolean;
  onToggleTools: () => void;
  onToggleScene: () => void;
}

/**
 * The strip under the viewport on phones and tablets.
 *
 * Mobile modelling apps keep what the hand needs most along one edge of the
 * screen, within reach of a thumb, and so does this: the drawers either side
 * and, on a touch screen, the keys a hand without a keyboard has no other way
 * to press. While a modal operation runs its buttons stand in for Enter, Esc
 * and, for the knife, Backspace.
 */
export function QuickBar({
  drawers,
  touch,
  toolsOpen,
  sceneOpen,
  hasTools,
  hasScene,
  onToggleTools,
  onToggleScene,
}: QuickBarProps) {
  return (
    <nav className="quick-bar" aria-label="Quick actions">
      {drawers && hasTools ? (
        <Button
          label="TOOLS"
          className="quick-bar__drawer"
          active={toolsOpen}
          aria-expanded={toolsOpen}
          aria-controls={TOOLS_DRAWER_ID}
          hint="Show or hide the tool panels: primitives, object and boolean tools, or the mesh operations in edit mode"
          onClick={onToggleTools}
        />
      ) : (
        <span />
      )}

      {touch ? <TouchActions /> : null}

      {drawers && hasScene ? (
        <Button
          label="SCENE"
          className="quick-bar__drawer"
          active={sceneOpen}
          aria-expanded={sceneOpen}
          aria-controls={SCENE_DRAWER_ID}
          hint="Show or hide the scene panels: outliner, properties and modifiers"
          onClick={onToggleScene}
        />
      ) : (
        <span />
      )}
    </nav>
  );
}

/** The keyboard's work, done with a finger. */
function TouchActions() {
  const modal = useEditorStore((state) => state.modal);
  const commandModal = useEditorStore((state) => state.commandModal);

  if (modal) {
    // `data-modal-control` lets these through the viewport's rule that any
    // press during a modal confirms it, which CANCEL must not do.
    return (
      <div className="quick-bar__actions" role="group" aria-label={`${modal.kind} controls`}>
        <Button
          label={modal.kind === 'knife' ? 'CUT' : 'CONFIRM'}
          variant="primary"
          data-modal-control=""
          hint={modal.kind === 'knife' ? 'Make the cut (Enter)' : 'Keep the result (Enter)'}
          onClick={() => commandModal('confirm')}
        />
        {modal.kind === 'knife' ? (
          <Button
            label="UNDO POINT"
            data-modal-control=""
            hint="Take the last point back (Backspace)"
            onClick={() => commandModal('back')}
          />
        ) : null}
        <Button
          label="CANCEL"
          data-modal-control=""
          hint="Call it off and put everything back (Esc)"
          onClick={() => commandModal('cancel')}
        />
      </div>
    );
  }

  return <EditActions />;
}

function EditActions() {
  const mode = useEditorStore((state) => state.mode);
  const canUndo = useEditorStore((state) => state.historyUndo.length > 0);
  const canRedo = useEditorStore((state) => state.historyRedo.length > 0);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const selectExtend = useEditorStore((state) => state.selectExtend);
  const setSelectExtend = useEditorStore((state) => state.setSelectExtend);
  const deleteSelected = useEditorStore((state) => state.deleteSelected);
  const openDeleteMenuAtPointer = useEditorStore((state) => state.openDeleteMenuAtPointer);

  return (
    <div className="quick-bar__actions" role="group" aria-label="Edit">
      <IconButton
        label="Undo"
        icon={<UndoIcon />}
        className="quick-bar__icon"
        disabled={!canUndo}
        hint={canUndo ? 'Undo the last step (Ctrl+Z)' : 'Undo: nothing to go back to yet'}
        onClick={undo}
      />
      <IconButton
        label="Redo"
        icon={<RedoIcon />}
        className="quick-bar__icon"
        disabled={!canRedo}
        hint={
          canRedo
            ? 'Redo the step just undone (Ctrl+Shift+Z)'
            : 'Redo: nothing undone to bring back'
        }
        onClick={redo}
      />
      <Button
        label="ADD"
        active={selectExtend}
        hint="Add to the selection: while this is on, a tap adds what it lands on and takes back what is already selected, and a drag adds everything in it, the way Shift does with a mouse"
        onClick={() => setSelectExtend(!selectExtend)}
      />
      <IconButton
        label="Delete"
        icon={<DeleteIcon />}
        className="quick-bar__icon"
        hint={
          mode === 'object'
            ? 'Delete the selected objects (X)'
            : 'Delete or dissolve the selected vertices, edges or faces (Delete)'
        }
        onClick={() => (mode === 'object' ? deleteSelected() : openDeleteMenuAtPointer())}
      />
    </div>
  );
}

/** The bar's icons, one 16 by 16 drawing each in `currentColor`, as the top bar's are. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="quick-bar__glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** An arrow turning back on itself, to the left. */
function UndoIcon() {
  return (
    <Glyph>
      <path d="M5.5 2.5 2 6l3.5 3.5" />
      <path d="M2 6h7.5a4 4 0 0 1 0 8H6" />
    </Glyph>
  );
}

/** The same arrow going forward again. */
function RedoIcon() {
  return (
    <Glyph>
      <path d="M10.5 2.5 14 6l-3.5 3.5" />
      <path d="M14 6H6.5a4 4 0 0 0 0 8H10" />
    </Glyph>
  );
}

/** A bin with its lid on. */
function DeleteIcon() {
  return (
    <Glyph>
      <path d="M2.5 4h11M6 4V2.5h4V4" />
      <path d="M4 4l.75 9.5h6.5L12 4" />
      <path d="M6.75 6.5v4.5M9.25 6.5v4.5" />
    </Glyph>
  );
}
