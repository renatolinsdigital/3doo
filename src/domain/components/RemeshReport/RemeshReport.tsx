import { Panel } from '@shared/components';
import { useEditorStore } from '@store/index';
import type { RemeshCounts } from '@store/index';

import './RemeshReport.scss';

const ROWS: { key: keyof RemeshCounts; label: string }[] = [
  { key: 'verts', label: 'VERTS' },
  { key: 'edges', label: 'EDGES' },
  { key: 'faces', label: 'FACES' },
  { key: 'tris', label: 'TRIS' },
  { key: 'quads', label: 'QUADS' },
  { key: 'ngons', label: 'NGONS' },
];

function percent(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

/** Signed change, so a reduction reads as one at a glance. */
function delta(before: number, after: number): string {
  if (before === 0) return after === 0 ? '—' : `+${after.toLocaleString()}`;
  const change = Math.round(((after - before) / before) * 100);
  return `${change > 0 ? '+' : ''}${change}%`;
}

/**
 * What the last run actually produced, next to what it started from.
 *
 * A remesh is judged on its numbers as much as on its look — the quad share and
 * the face count are the whole reason for running one — so they sit beside the
 * viewport rather than flashing past in the status bar.
 */
export function RemeshReport() {
  const report = useEditorStore((state) => state.remeshReport);
  const pending = useEditorStore((state) => state.remeshPreview !== null);
  const busy = useEditorStore((state) => state.remeshBusy);

  if (busy) {
    return (
      <Panel title="RESULT">
        <p className="remesh-report__empty">Rebuilding the topology…</p>
      </Panel>
    );
  }

  if (!report) {
    return (
      <Panel title="RESULT">
        <p className="remesh-report__empty">
          Nothing remeshed yet. Pick an object, then REMESH to see what the settings give before
          keeping it.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="RESULT" className="remesh-report">
      <p className={`remesh-report__state${pending ? ' remesh-report__state--pending' : ''}`}>
        {pending
          ? `${report.objectName} is showing an uncommitted result — APPLY or REVERT`
          : `${report.objectName} — applied`}
      </p>

      <table className="remesh-report__table">
        <thead>
          <tr>
            <th scope="col">
              <span className="u-visually-hidden">Element</span>
            </th>
            <th scope="col">BEFORE</th>
            <th scope="col">AFTER</th>
            <th scope="col">Δ</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>{report.before[row.key].toLocaleString()}</td>
              <td>{report.after[row.key].toLocaleString()}</td>
              <td>{delta(report.before[row.key], report.after[row.key])}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="remesh-report__facts">
        <Fact label="QUAD SHARE" value={percent(report.after.quads, report.after.faces)} />
        {report.voxelSize > 0 ? (
          <>
            <Fact label="VOXEL" value={`${report.voxelSize.toFixed(3)} m`} />
            <Fact
              label="GRID"
              value={`${report.resolution.x}×${report.resolution.y}×${report.resolution.z}`}
            />
          </>
        ) : null}
        <Fact label="TIME" value={`${Math.max(1, Math.round(report.elapsedMs))} ms`} />
      </dl>

      {report.warnings.length > 0 ? (
        <ul className="remesh-report__warnings">
          {report.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="remesh-report__fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
