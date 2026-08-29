import type { ReactNode } from 'react';

import { cx } from '@shared/utils/cx';
import { useEditorStore, useSceneStats } from '@store/index';
import type { ModalTransform, OperationProgress } from '@store/types';

import './StatusBar.scss';

/** "SCALE X ×1.420": what the transform has reached so far. */
function modalLabel(modal: ModalTransform): string {
  const kind = modal.kind.toUpperCase();
  const axis = modal.axis ? ` ${modal.axis.toUpperCase()}` : '';
  if (modal.typed) return `${kind}${axis} ${modal.typed}`;

  // A rotation carries its angle in x whatever axis it turns about, and there is
  // one angle, not three, and the axis is already spelled out beside it.
  if (modal.kind === 'rotate') return `${kind}${axis} ${modal.value.x.toFixed(1)}°`;
  if (modal.kind !== 'scale') return `${kind}${axis}`;

  const factor = modal.axis ? modal.value[modal.axis] : modal.value.x;
  return `${kind}${axis} ×${factor.toFixed(3)}`;
}

export function StatusBar() {
  const stats = useSceneStats();
  const status = useEditorStore((state) => state.status);
  const mode = useEditorStore((state) => state.mode);
  const selectMode = useEditorStore((state) => state.selectMode);
  const snap = useEditorStore((state) => state.snap);
  const proportional = useEditorStore((state) => state.proportional);
  const pivot = useEditorStore((state) => state.pivot);
  const modal = useEditorStore((state) => state.modal);
  const showStatistics = useEditorStore((state) => state.overlays.statistics);
  const progress = useEditorStore((state) => state.progress);

  return (
    <footer className="status-bar">
      <div className="status-bar__section status-bar__section--message">
        <span className="status-bar__label">{progress ? progress.label : 'STATUS'}</span>
        {progress ? (
          <Progress progress={progress} />
        ) : (
          <span className="status-bar__value" role="status" aria-live="polite">
            {modal ? `${modalLabel(modal)}: LMB confirm, Esc cancel` : status}
          </span>
        )}
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
        <Flag on={pivot === 'cursor'}>PIVOT {pivot === 'cursor' ? 'CURSOR' : 'MEDIAN'}</Flag>
        <Flag on={snap.enabled}>SNAP {snap.enabled ? snap.mode.toUpperCase() : 'OFF'}</Flag>
        <Flag on={proportional.enabled}>
          PROP {proportional.enabled ? proportional.falloff.toUpperCase() : 'OFF'}
        </Flag>
      </div>
    </footer>
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
