import { useEditorStore, useSceneStats } from '@store/index';

import './StatusBar.scss';

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

  return (
    <footer className="status-bar">
      <div className="status-bar__section status-bar__section--message">
        <span className="status-bar__label">STATUS</span>
        <span className="status-bar__value" role="status" aria-live="polite">
          {modal
            ? `${modal.kind.toUpperCase()}${modal.axis ? ` ${modal.axis.toUpperCase()}` : ''}${
                modal.typed ? ` ${modal.typed}` : ''
              } — LMB confirm, Esc cancel`
            : status}
        </span>
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
        <span className={`status-bar__flag${mode === 'edit' ? ' status-bar__flag--on' : ''}`}>
          {mode === 'edit' ? `EDIT / ${selectMode.toUpperCase()}` : 'OBJECT'}
        </span>
        <span className={`status-bar__flag${pivot === 'cursor' ? ' status-bar__flag--on' : ''}`}>
          PIVOT {pivot === 'cursor' ? 'CURSOR' : 'MEDIAN'}
        </span>
        <span className={`status-bar__flag${snap.enabled ? ' status-bar__flag--on' : ''}`}>
          SNAP {snap.enabled ? snap.mode.toUpperCase() : 'OFF'}
        </span>
        <span className={`status-bar__flag${proportional.enabled ? ' status-bar__flag--on' : ''}`}>
          PROP {proportional.enabled ? proportional.falloff.toUpperCase() : 'OFF'}
        </span>
      </div>
    </footer>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="status-bar__metric">
      <span className="status-bar__label">{label}</span>
      <span className="status-bar__value">{value.toLocaleString()}</span>
    </span>
  );
}
