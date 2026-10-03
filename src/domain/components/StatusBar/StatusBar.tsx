import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cx } from '@shared/utils/cx';
import { snapStepLabel, useEditorStore, useSceneStats } from '@store/index';
import type { ModalTransform, OperationProgress } from '@store/types';

import './StatusBar.scss';

/** "SCALE X ×1.420": what the transform has reached so far. */
function modalLabel(modal: ModalTransform): string {
  const kind = modal.kind.toUpperCase();
  const axis = modal.axis ? ` ${modal.axis.toUpperCase()}` : '';
  if (modal.typed) return `${kind}${axis} ${modal.typed}`;

  // A slide says what it is moving rather than which axis it is on: it runs
  // along the mesh's own edges, and there is no axis to name.
  if (modal.kind === 'slide') {
    return `SLIDE ${(modal.element ?? 'vertex').toUpperCase()} ${modal.value.x.toFixed(3)}`;
  }

  // A rotation carries its angle in x whatever axis it turns about, and there is
  // one angle, not three, and the axis is already spelled out beside it.
  if (modal.kind === 'rotate') return `${kind}${axis} ${modal.value.x.toFixed(1)}°`;

  // A bevel, an inset or an extrude is one distance dragged against the model,
  // and it rides in x for the same reason.
  if (modal.kind === 'bevel' || modal.kind === 'inset' || modal.kind === 'extrude') {
    return `${kind} ${modal.value.x.toFixed(3)}`;
  }

  // A knife cut is clicked out point by point, with nothing to measure until it is made.
  if (modal.kind === 'knife') {
    return `KNIFE ${modal.value.x} POINT${modal.value.x === 1 ? '' : 'S'}`;
  }
  if (modal.kind !== 'scale') return `${kind}${axis}`;

  const factor = modal.axis ? modal.value[modal.axis] : modal.value.x;
  return `${kind}${axis} ×${factor.toFixed(3)}`;
}

/**
 * The keys a modal operation answers to, for the end of its status line.
 *
 * Every other one ends on a click. A knife cut is made of clicks, so a click
 * adds to it and Enter is what ends it.
 */
function modalKeys(modal: ModalTransform): string {
  return modal.kind === 'knife'
    ? 'LMB add point, Enter cut, Backspace undo point, E new line, Esc cancel'
    : 'LMB confirm, Esc cancel';
}

/**
 * How long the disk stays up after a write, and how long its turn takes.
 *
 * Paired with the `save-spin` keyframes, which run for the same span: the
 * animation draws one revolution and this takes the disk back off the bar as
 * that revolution closes. Change one and the other has to move with it, or
 * the disk is cut off mid-turn or left sitting still at the end of it.
 */
const SAVE_SPIN_MS = 2500;

/**
 * Whether the autosave disk should be up and turning.
 *
 * Driven off the store's counter rather than off `dirty`, which the autosave
 * lowers before the write goes out: turning on that would report a write
 * that has not happened yet, and would keep reporting it when the write
 * failed. The counter is bumped only once a write has landed.
 *
 * What starts the turn is the counter moving on from where this bar last
 * saw it, not the counter being above zero. A bar mounting into a session
 * that has been writing for an hour, because the status bar was switched
 * back on in preferences or the editor came back from DOCS, has missed those
 * writes rather than witnessed them, and announcing the last one on arrival
 * would report a save that did not just happen.
 */
function useSaveSpin(): boolean {
  const token = useEditorStore((state) => state.autosaveToken);
  const seen = useRef(token);
  const [showing, setShowing] = useState(false);

  useEffect(() => {
    if (token === seen.current) return;
    seen.current = token;
    setShowing(true);
    // Restarted rather than left to finish, so a write landing mid-turn reads
    // as two saves rather than as one long one.
    const timer = window.setTimeout(() => setShowing(false), SAVE_SPIN_MS);
    return () => window.clearTimeout(timer);
  }, [token]);

  return showing;
}

export function StatusBar() {
  const stats = useSceneStats();
  const status = useEditorStore((state) => state.status);
  const mode = useEditorStore((state) => state.mode);
  const selectMode = useEditorStore((state) => state.selectMode);
  const snapEnabled = useEditorStore((state) => state.snapEnabled);
  const snapMode = useEditorStore((state) => state.snapMode);
  const snapStep = useEditorStore((state) => state.snapStep);
  const proportional = useEditorStore((state) => state.proportional);
  const autoMerge = useEditorStore((state) => state.autoMerge);
  const pivot = useEditorStore((state) => state.pivot);
  const modal = useEditorStore((state) => state.modal);
  const showStatistics = useEditorStore((state) => state.overlays.statistics);
  const progress = useEditorStore((state) => state.progress);
  const saving = useSaveSpin();

  return (
    <footer className="status-bar">
      <div className="status-bar__section status-bar__section--message">
        <span className="status-bar__label">{progress ? progress.label : 'STATUS'}</span>
        {progress ? (
          <Progress progress={progress} />
        ) : (
          <span className="status-bar__value" role="status" aria-live="polite">
            {modal ? `${modalLabel(modal)}: ${modalKeys(modal)}` : status}
          </span>
        )}
        <SaveSpin showing={saving} />
      </div>

      {showStatistics ? (
        <div className="status-bar__section">
          <Metric label="OBJ" value={stats.objects} />
          <Metric label="VERTS" value={stats.verts} />
          <Metric label="EDGES" value={stats.edges} />
          <Metric label="FACES" value={stats.faces} />
          <Metric label="TRIS" value={stats.tris} />
        </div>
      ) : null}

      {mode === 'edit' ? (
        <div className="status-bar__section">
          <Metric label="SEL V" value={stats.selectedVerts} />
          <Metric label="SEL E" value={stats.selectedEdges} />
          <Metric label="SEL F" value={stats.selectedFaces} />
        </div>
      ) : null}

      <div className="status-bar__section status-bar__section--flags">
        <Flag on={mode === 'edit'}>
          {mode === 'edit' ? `EDIT / ${selectMode.toUpperCase()}` : 'OBJECT'}
        </Flag>
        {/* Lit whenever the pivot is off the default, the way the flags beside
            it light when their setting is on. */}
        <Flag on={pivot !== 'median'}>PIVOT {pivot.toUpperCase()}</Flag>
        <Flag on={snapEnabled}>SNAP {snapEnabled ? snapStepLabel(snapMode, snapStep) : 'OFF'}</Flag>
        <Flag on={proportional.enabled}>
          PROP {proportional.enabled ? proportional.falloff.toUpperCase() : 'OFF'}
        </Flag>
        <Flag on={autoMerge.enabled}>
          MERGE {autoMerge.enabled ? autoMerge.threshold.toFixed(3) : 'OFF'}
        </Flag>
      </div>
    </footer>
  );
}

/**
 * A disk, turning once where the status message ends, after a write lands.
 *
 * The slot stays in the layout whether or not the disk is in it, so the
 * status message beside it does not reflow every time a write lands.
 *
 * Hidden from screen readers on purpose. The message slot it sits in is a
 * live region, so announcing this would cut across whatever the editor was
 * saying every time the timer came round, to report something the user did
 * not ask for and cannot act on. The AUTOSAVE preference is where the
 * behaviour is stated.
 */
function SaveSpin({ showing }: { showing: boolean }) {
  return (
    <span className={cx('status-bar__save', showing && 'status-bar__save--on')} aria-hidden="true">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <path d="M2.75 2.75h7.5l3 3v7.5h-10.5z" />
        <path d="M5.5 2.75v3.5h4v-3.5" />
        <path d="M4.75 13.25v-4h6.5v4" />
      </svg>
    </span>
  );
}

/**
 * How far along a long operation is.
 *
 * A real `progressbar` rather than a styled div, so a screen reader announces
 * the percentage as it climbs instead of reading a decorative bar as nothing.
 */
function Progress({ progress }: { progress: OperationProgress }) {
  const percent = Math.round(Math.min(1, Math.max(0, progress.value)) * 100);

  return (
    <span
      className="status-bar__progress"
      role="progressbar"
      aria-label={progress.label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="status-bar__progress-track">
        <span className="status-bar__progress-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="status-bar__progress-value">{percent}%</span>
    </span>
  );
}

/** A setting the viewport is under, lit while it is in force. */
function Flag({ on, children }: { on: boolean; children: ReactNode }) {
  return <span className={cx('status-bar__flag', on && 'status-bar__flag--on')}>{children}</span>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="status-bar__metric">
      <span className="status-bar__label">{label}</span>
      <span className="status-bar__value">{value.toLocaleString()}</span>
    </span>
  );
}
