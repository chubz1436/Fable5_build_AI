import type { Evidence } from '../../../shared/types';
import { WorkerChip } from './bits';

export function EvidencePanel({ evidence }: { evidence: Evidence }) {
  const confidencePct = Math.round(evidence.confidence * 100);
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <h3>Delivery summary</h3>
        <p style={{ margin: '0 0 8px' }}>{evidence.summary}</p>
        <div className="tc-meta">
          <WorkerChip workerId={evidence.workerId} />
          <span className={`badge ${confidencePct >= 85 ? 'b-success' : 'b-warning'}`}>
            confidence {confidencePct}%
          </span>
          {evidence.finalOwnerAction && (
            <span className={`badge ${evidence.finalOwnerAction === 'accepted' ? 'b-success' : 'b-warning'}`}>
              owner: {evidence.finalOwnerAction === 'accepted' ? 'accepted' : 'changes requested'}
            </span>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Original request</h3>
        <p className="muted small" style={{ margin: 0, fontStyle: 'italic' }}>
          “{evidence.request}”
        </p>
      </div>

      <div className="card">
        <h3>Work performed</h3>
        <ul className="criteria">
          {evidence.workPerformed.map((w, i) => (
            <li key={i}>
              <span className="crit-mark" style={{ color: 'var(--success)' }}>✓</span> {w}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>Changed files ({evidence.filesChanged.length})</h3>
        {evidence.filesChanged.map((f) => (
          <div className="file-row" key={f.path}>
            <span
              className={`badge ${
                f.changeType === 'added' ? 'b-success' : f.changeType === 'deleted' ? 'b-danger' : 'b-info'
              }`}
            >
              {f.changeType[0]!.toUpperCase()}
            </span>
            <span className="file-path">{f.path}</span>
            <span className="diff-add">+{f.additions}</span>
            <span className="diff-del">−{f.deletions}</span>
            <span className="muted small" style={{ flexBasis: '100%', paddingLeft: 34 }}>
              {f.summary}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Tests</h3>
        <div className="tc-meta" style={{ marginBottom: 8 }}>
          <span className="badge b-success">{evidence.tests.passed} passed</span>
          <span className={`badge ${evidence.tests.failed ? 'b-danger' : 'b-outline'}`}>
            {evidence.tests.failed} failed
          </span>
          <span className="badge b-outline">{evidence.tests.skipped} skipped</span>
          <span className="badge b-outline">{(evidence.tests.durationMs / 1000).toFixed(1)}s</span>
        </div>
        <ul className="criteria">
          {evidence.tests.details.map((d, i) => (
            <li key={i} className="mono small muted">{d}</li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>Log tail</h3>
        <div className="log-console" style={{ maxHeight: 140 }}>
          {evidence.logTail.map((l, i) => (
            <div className="log-line" key={i}>{l}</div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Limitations</h3>
        <ul className="criteria">
          {evidence.limitations.map((l, i) => (
            <li key={i}>
              <span className="crit-mark" style={{ color: 'var(--warning)' }}>⚠</span> {l}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
