import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Button, Modal, SegmentedControl, type SegmentedOption, Select } from '@shared/components';
import { useEditorStore } from '@store/index';

import { SCRIPT_EXAMPLES, STARTER_SCRIPT } from '../../scripting/examples';
import { runScript } from '../../scripting/runScript';
import { type SceneScript, sceneScript } from '../../scripting/sceneScript';
import { ScriptEditor, type ScriptEditorHandle } from '../ScriptEditor/ScriptEditor';

import './ScriptDialog.scss';

/**
 * Where the script being written is kept between visits.
 *
 * The browser rather than the project: a script is a tool for making the
 * scene, not part of it, and losing an hour's typing to a reload or a trip to
 * the docs would be worse than any file format question. Kept per person, as
 * the preferences are.
 */
export const DRAFT_KEY = '3doo:script';

function readDraft(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? STARTER_SCRIPT;
  } catch {
    return STARTER_SCRIPT;
  }
}

function writeDraft(source: string): void {
  try {
    window.localStorage.setItem(DRAFT_KEY, source);
  } catch {
    // Storage refused (a private window, a full quota): the draft lives on in
    // the dialog until the page goes.
  }
}

const PICK = 'pick';

const EXAMPLE_OPTIONS = [
  { value: PICK, label: 'LOAD AN EXAMPLE' },
  ...SCRIPT_EXAMPLES.map((example) => ({ value: example.id, label: example.label })),
];

type Tab = 'scene' | 'editor';

const TABS: readonly SegmentedOption<Tab>[] = [
  { value: 'scene', label: 'SCENE', hint: 'The scene as the script that builds it' },
  { value: 'editor', label: 'EDITOR', hint: 'Write a script and run it against the scene' },
];

/** Stands in for the script of an empty scene, which has nothing in it. */
export const EMPTY_SCENE = '// The scene is empty.';

/** What a run of the copied script leaves out, or null when it builds the whole scene. */
function shortfall(gaps: number): string | null {
  if (gaps === 0) return null;
  return gaps === 1
    ? 'One thing in the scene has no script form yet, so a run leaves it out'
    : `${gaps} things in the scene have no script form yet, so a run leaves them out`;
}

/**
 * What the dialog warns while any object still has modifiers, or null when none
 * does. A script writes and reads base meshes, so the shape a stack gives is
 * only in it once the stack is applied.
 */
function unapplied(modified: readonly string[]): string | null {
  if (modified.length === 0) return null;
  const who =
    modified.length === 1
      ? `${modified[0]} still has modifiers on its stack`
      : `${modified.length} objects still have modifiers on their stacks`;
  return `Scripts map the scene fully only once every modifier is applied. ${who}`;
}

/**
 * The scene as script, read again whenever it changes while the dialog is open.
 * Shut, it follows nothing: a drag changes the scene on every pointer move.
 */
function useSceneScript(open: boolean): SceneScript | null {
  const scene = useEditorStore(
    useShallow((state) =>
      open
        ? {
            objects: state.objects,
            groups: state.groups,
            cursor: state.cursor,
            // An edit changes a mesh in place and says so here, leaving `objects` as it was.
            meshVersion: state.meshVersion,
          }
        : null,
    ),
  );
  return useMemo(() => scene && sceneScript(scene), [scene]);
}

interface Problem {
  message: string;
  line: number | null;
  /** Bumped on every failed run, so the editor goes to the line again. */
  key: number;
}

/**
 * The scripting window, in two tabs.
 *
 * SCENE shows the scene on screen written as the script that builds it, read
 * only, and can copy it. EDITOR is where a script is written and run. Both stay
 * mounted while the dialog is open, so switching between them keeps the
 * editor's own undo.
 *
 * A run that fails says why twice over, in a toast and under the code, and
 * leaves the dialog open on the line that failed with the scene untouched. A
 * run that works says what it did in a toast and gets out of the way, so the
 * result is there in the viewport.
 */
export function ScriptDialog() {
  const open = useEditorStore((state) => state.dialog === 'script');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const pushToast = useEditorStore((state) => state.pushToast);

  const [tab, setTab] = useState<Tab>('scene');
  const [source, setSource] = useState(readDraft);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [copied, setCopied] = useState(false);
  const scene = useSceneScript(open);
  const empty = !scene || scene.source === '';
  const modified = useEditorStore(
    useShallow((state) =>
      open
        ? state.objects.filter((object) => object.modifiers.length > 0).map(({ name }) => name)
        : [],
    ),
  );
  const warning = unapplied(modified);
  const failures = useRef(0);
  const editor = useRef<ScriptEditorHandle>(null);

  useEffect(() => writeDraft(source), [source]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const run = async () => {
    if (running) return;
    setRunning(true);
    const outcome = await runScript(source);
    setRunning(false);

    if (outcome.ok) {
      setProblem(null);
      pushToast('success', outcome.message);
      closeDialog();
      return;
    }

    failures.current += 1;
    setProblem({ message: outcome.message, line: outcome.line, key: failures.current });
    pushToast(
      'error',
      outcome.line === null
        ? `Script failed: ${outcome.message}`
        : `Script failed on line ${outcome.line}: ${outcome.message}`,
    );
  };

  const loadExample = (id: string) => {
    const example = SCRIPT_EXAMPLES.find((candidate) => candidate.id === id);
    if (!example) return;
    if (editor.current) editor.current.replaceAll(example.source);
    else setSource(example.source);
    setProblem(null);
  };

  const copyScript = async () => {
    if (!scene) return;
    try {
      await navigator.clipboard.writeText(scene.source);
    } catch {
      // The clipboard API is missing outside a secure context and a browser
      // may refuse it. The script on screen is all of it, so the keyboard can
      // copy it instead.
      pushToast('error', 'The browser blocked copying. Select the script and press Ctrl+C instead');
      return;
    }
    setCopied(true);
    const missing = shortfall(scene.gaps);
    if (missing) pushToast('warning', `Copied. ${missing}`);
  };

  return (
    <Modal
      title="SCRIPT"
      open={open}
      onClose={closeDialog}
      className="script-dialog"
      footer={
        tab === 'scene' ? (
          <>
            <Button label="CLOSE" onClick={closeDialog} />
            <Button
              label={copied ? 'COPIED' : 'COPY'}
              variant="primary"
              disabled={empty}
              hint="Copy the script. Run in EDITOR on a new project, it builds this scene again"
              onClick={() => void copyScript()}
            />
          </>
        ) : (
          <>
            <Button label="CLOSE" onClick={closeDialog} />
            <Button
              label={running ? 'RUNNING' : 'RUN'}
              variant="primary"
              disabled={running}
              hint="Run the script against the scene (Ctrl+Enter). The whole run is one step to undo"
              onClick={() => void run()}
            />
          </>
        )
      }
    >
      <div className="script-dialog__toolbar">
        <div className="script-dialog__controls">
          <SegmentedControl label="Script tabs" options={TABS} value={tab} onChange={setTab} />
          {tab === 'editor' && (
            <Select
              label="EXAMPLE"
              value={PICK}
              options={EXAMPLE_OPTIONS}
              hint="Replace the script with a worked example. Ctrl+Z in the editor brings yours back"
              onChange={loadExample}
            />
          )}
        </div>
        <a
          className="script-dialog__reference"
          href="/docs#scripting"
          target="_blank"
          rel="noopener noreferrer"
        >
          API REFERENCE ↗
        </a>
      </div>

      {warning && (
        <p className="script-dialog__warning" role="status">
          <span className="script-dialog__warning-label">WARNING</span>
          <span>{warning}</span>
        </p>
      )}

      <div className="script-dialog__panel" hidden={tab !== 'scene'}>
        <ScriptEditor
          label="Scene"
          value={empty ? EMPTY_SCENE : (scene?.source ?? '')}
          readOnly
          autoFocus={tab === 'scene'}
        />
      </div>

      <div className="script-dialog__panel" hidden={tab !== 'editor'}>
        <ScriptEditor
          ref={editor}
          label="Script"
          value={source}
          onChange={setSource}
          onRun={() => void run()}
          autoFocus={tab === 'editor'}
          errorLine={problem?.line ?? null}
          errorKey={problem?.key ?? 0}
        />

        {problem && (
          <p className="script-dialog__problem">
            <span className="script-dialog__problem-where">
              {problem.line === null ? 'FAILED' : `LINE ${problem.line}`}
            </span>
            <span>{problem.message}</span>
          </p>
        )}
      </div>
    </Modal>
  );
}
