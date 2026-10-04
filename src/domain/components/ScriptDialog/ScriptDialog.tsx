import { useEffect, useRef, useState } from 'react';

import { Button, Modal, Select } from '@shared/components';
import { useEditorStore } from '@store/index';

import { SCRIPT_EXAMPLES, STARTER_SCRIPT } from '../../scripting/examples';
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

interface Problem {
  message: string;
  line: number | null;
  /** Bumped on every failed run, so the editor goes to the line again. */
  key: number;
}

/**
 * The scripting window: write JavaScript against the scene, then run it.
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

  const [source, setSource] = useState(readDraft);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const failures = useRef(0);
  const editor = useRef<ScriptEditorHandle>(null);

  useEffect(() => writeDraft(source), [source]);

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

  return (
    <Modal
      title="SCRIPT"
      open={open}
      onClose={closeDialog}
      className="script-dialog"
      footer={
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
      }
    >
      <div className="script-dialog__toolbar">
        <Select
          label="EXAMPLE"
          value={PICK}
          options={EXAMPLE_OPTIONS}
          hint="Replace the script with a worked example. Ctrl+Z in the editor brings yours back"
          onChange={loadExample}
        />
        <a
          className="script-dialog__reference"
          href="/docs#scripting"
          target="_blank"
          rel="noopener noreferrer"
        >
          API REFERENCE ↗
        </a>
      </div>

      <ScriptEditor
        ref={editor}
        label="Script"
        value={source}
        onChange={setSource}
        onRun={() => void run()}
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
    </Modal>
  );
}
