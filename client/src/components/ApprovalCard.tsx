import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Approval } from '../../../shared/types';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useLookups } from '../lib/store';
import { RiskBadge } from './bits';

const TYPE_LABEL: Record<Approval['type'], string> = {
  start: 'Start approval',
  midrun: 'Mid-run gate',
  completion: 'Delivery review',
};

export function ApprovalCard({ approval }: { approval: Approval }) {
  const { taskById } = useLookups();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const task = taskById(approval.taskId);
  const pending = approval.status === 'pending';

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(approval.id, decision, note.trim() || undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`card approval-card ${pending ? '' : 'decided'}`}>
      <div className="approval-head">
        <div>
          <div className="approval-title">{approval.title}</div>
          {task && (
            <Link to={`/tasks/${task.id}`} className="small muted">
              {task.title} ↗
            </Link>
          )}
        </div>
        <div className="tc-meta">
          <span className="badge b-info">{TYPE_LABEL[approval.type]}</span>
          <RiskBadge risk={approval.risk} />
          {!pending && (
            <span
              className={`badge ${
                approval.status === 'approved'
                  ? 'b-success'
                  : approval.status === 'rejected'
                    ? 'b-danger'
                    : 'b-neutral'
              }`}
            >
              {approval.status}
            </span>
          )}
        </div>
      </div>

      <p className="small" style={{ margin: 0 }}>{approval.description}</p>

      <dl className="kv">
        {approval.baseCommit && (
          <>
            <dt>Base commit</dt>
            <dd className="mono small">{approval.baseCommit.slice(0, 12)} (grant is void if the repo moves)</dd>
          </>
        )}
        {approval.expiresAt && approval.status === 'pending' && (
          <>
            <dt>Expires</dt>
            <dd className="small">{new Date(approval.expiresAt).toLocaleTimeString()}{approval.singleUse ? ' · single-use' : ''}</dd>
          </>
        )}
        <dt>Affected scope</dt>
        <dd className="mono small">{approval.affectedScope.join(', ') || '—'}</dd>
        <dt>Recommendation</dt>
        <dd>
          <b style={{ color: approval.recommendedAction === 'approve' ? 'var(--success)' : 'var(--danger)' }}>
            {approval.recommendedAction === 'approve' ? 'Approve' : 'Reject'}
          </b>{' '}
          <span className="muted">— {approval.recommendationReason}</span>
        </dd>
        <dt>Requested</dt>
        <dd>{timeAgo(approval.createdAt)}</dd>
        {approval.decisionNote && (
          <>
            <dt>Owner note</dt>
            <dd>{approval.decisionNote}</dd>
          </>
        )}
      </dl>

      {pending && (
        <div className="approval-actions">
          <input
            className="note-input"
            placeholder="Optional note (e.g. why you rejected)…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="btn success" disabled={busy} onClick={() => decide('approve')}>
            ✓ Approve
          </button>
          <button className="btn danger" disabled={busy} onClick={() => decide('reject')}>
            ✗ Reject
          </button>
        </div>
      )}
      {error && <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>}
    </div>
  );
}
