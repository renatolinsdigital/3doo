import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Button, Modal, SegmentedControl, type SegmentedOption, Select } from '@shared/components';
import { useEditorStore } from '@store/index';

import { SCRIPT_EXAMPLES, STARTER_SCRIPT } from '../../scripting/examples';
import {
  type ActionScript,
  actionLogIsEmpty,
  actionLogText,
  actionScript,
  clearActionLog,
  subscribeActionLog,
} from '../../scripting/recorder';
import { runScript } from '../../scripting/runScript';
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

type Tab = 'actions' | 'editor';

const TABS: readonly SegmentedOption<Tab>[] = [
  { value: 'actions', label: 'ACTIONS', hint: 'What you do in the viewport, written as script' },
  { value: 'editor', label: 'EDITOR', hint: 'Write a script and run it against the scene' },
];

/** Stands in for an empty log, so the tab says what is going to appear in it. */
export const EMPTY_LOG = '// What you do in the viewport is written here as script.';

/**
 * The log, read only. Its own component so that only an open dialog follows
 * every change to it: a drag changes it on every pointer move.
 */
function ActionLog({ autoFocus }: { autoFocus: boolean }) {
  const log = useSyncExternalStore(subscribeActionLog, actionLogText);
  return <ScriptEditor label="Actions" value={log || EMPTY_LOG} readOnly autoFocus={autoFocus} />;
}

interface Problem {
  message: string;
  line: number | null;
  /** Bumped on every failed run, so the editor goes to the line again. */
  key: number;
}

/** What a run of the log will not rebuild, or null when it rebuilds the whole scene. */
function scriptShortfall({ gaps, fromEmpty }: ActionScript): string | null {
  if (!fromEmpty) {
    return 'The log began on objects it did not make, so a run repeats only what came after';
  }
  if (gaps === 0) return null;
  return gaps === 1
    ? 'One step in the log has no script equivalent, so a run leaves it out'
    : `${gaps} steps in the log have no script equivalent, so a run leaves them out`;
}

/**
 * The scripting window, in two tabs.
 *
 * ACTIONS shows what has been done in the viewport, written as the script
 * that would do it, and can copy that script or hand it to the editor. EDITOR is where a
 * script is written and run. Both stay mounted while the dialog is open, so
 * switching between them keeps the editor's own undo.
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

  const [tab, setTab] = useState<Tab>('actions');
  const [source, setSource] = useState(readDraft);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [copied, setCopied] = useState(false);
  const logEmpty = useSyncExternalStore(subscribeActionLog, actionLogIsEmpty);
  const failures = useRef(0);
  const editor = useRef<ScriptEditorHandle>(null);
  /** The log on its way into the editor, which can only take it once it is showing. */
  const handover = useRef<string | null>(null);

  useEffect(() => writeDraft(source), [source]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useLayoutEffect(() => {
    if (tab !== 'editor' || handover.current === null) return;
    editor.current?.replaceAll(handover.current);
    handover.current = null;
    setProblem(null);
  }, [tab]);

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

  const openInEditor = () => {
    const script = actionScript();
    handover.current = script.source;
    setTab('editor');
    const shortfall = scriptShortfall(script);
    if (shortfall) pushToast('warning', shortfall);
  };

  const copyScript = async () => {
    const script = actionScript();
    try {
      await navigator.clipboard.writeText(script.source);
    } catch {
      // The clipboard API is missing outside a secure context and a browser
      // may refuse it. The log on screen lacks the lines that clear the scene
      // first, so selecting it for the copy shortcut would hand over less.
      pushToast(
        'error',
        'The browser blocked copying. OPEN IN EDITOR takes the script to the editor instead',
      );
      return;
    }
    setCopied(true);
    const shortfall = scriptShortfall(script);
    if (shortfall) pushToast('warning', `Copied. ${shortfall}`);
  };

  return (
    <Modal
      title="SCRIPT"
      open={open}
      onClose={closeDialog}
      className="script-dialog"
      footer={
        tab === 'actions' ? (
          <>
            <Button
              label="CLEAR"
              disabled={logEmpty}
              hint="Empty the log. The scene stays as it is"
              onClick={clearActionLog}
            />
            <Button label="CLOSE" onClick={closeDialog} />
            <Button
              label={copied ? 'COPIED' : 'COPY'}
              disabled={logEmpty}
              hint="Copy the log as a script that builds this scene again when run in EDITOR"
              onClick={() => void copyScript()}
            />
            <Button
              label="OPEN IN EDITOR"
              variant="primary"
              disabled={logEmpty}
              hint="Replace the script in the editor with this log. Ctrl+Z in the editor brings yours back"
              onClick={openInEditor}
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

      <div className="script-dialog__panel" hidden={tab !== 'actions'}>
        <ActionLog autoFocus={tab === 'actions'} />
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
