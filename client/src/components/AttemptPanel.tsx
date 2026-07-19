import { useState } from 'react';
import type { Attempt, OperationRecord } from '../../../shared/types';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';

const STATE_TONE: Record<string, string> = {
  creating_worktree: 'b-accent',
  running: 'b-accent',
  validating: 'b-accent',
  cancelling: 'b-warning',
  cancellation_failed: 'b-danger',
  termination_failed: 'b-danger',
  ready_for_review: 'b-success',
  accepted: 'b-success',
  rejected: 'b-warning',
  cancelled: 'b-neutral',
  failed: 'b-danger',
  timeout: 'b-danger',
  unknown_outcome: 'b-danger',
  blocked_reconciliation: 'b-warning',
};

const VALIDATION_TONE: Record<string, string> = {
  VERIFIED: 'b-success',
  PARTIAL: 'b-warning',
  UNVERIFIED: 'b-warning',
  FAILED: 'b-danger',
};

/** Durable attempt record: identity, worktree, operations, recovery state. */
export function AttemptPanel({ attempt, operations }: { attempt: Attempt; operations: OperationRecord[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // an attempt whose cancellation/termination was never confirmed is NOT
  // terminal: its processes may still be running and its leases are
  // deliberately held
  const terminal = !['creating_worktree', 'running', 'validating', 'cancelling', 'cancellation_failed', 'termination_failed'].includes(
    attempt.state,
  );
  // truthful cleanup semantics (P0-2): with a checkpoint the work survives on
  // the branch; without one, removal permanently destroys uncommitted work.
  const hasCheckpoint = !!attempt.checkpointCommit;

  return (
    <div className="card">
      <h3>Attempt {attempt.id.slice(-8)}</h3>
      <div className="tc-meta" style={{ marginBottom: 8 }}>
        <span className={`badge dot ${STATE_TONE[attempt.state] ?? 'b-neutral'}`}>{attempt.state.replaceAll('_', ' ')}</span>
        {attempt.validation && (
          <span className={`badge ${VALIDATION_TONE[attempt.validation.status]}`}>validation: {attempt.validation.status}</span>
        )}
        <span className="badge b-outline">{attempt.adapter} runner</span>
        {attempt.worktreeHealth && attempt.worktreeHealth !== 'ok' && (
          <span className="badge b-danger">worktree: {attempt.worktreeHealth}</span>
        )}
      </div>
      <dl className="kv">
        <dt>Branch</dt>
        <dd className="mono small">{attempt.branchName ?? '—'} (base {attempt.baseCommit.slice(0, 10)})</dd>
        <dt>Worktree</dt>
        <dd className="mono small">{attempt.worktreeCleanedAt ? 'removed' : attempt.worktreePath ?? '—'}</dd>
        {attempt.checkpointCommit && (
          <>
            <dt>Checkpoint</dt>
            <dd className="mono small">{attempt.checkpointCommit.slice(0, 12)} (durable on {attempt.branchName})</dd>
          </>
        )}
        {attempt.executablePath && (
          <>
            <dt>Executable</dt>
            <dd className="mono small">{attempt.executablePath}{attempt.executableVersion ? ` (${attempt.executableVersion})` : ''}</dd>
          </>
        )}
        <dt>Started</dt>
        <dd className="small">{timeAgo(attempt.startedAt)}{attempt.endedAt ? ` · ended ${timeAgo(attempt.endedAt)}` : ''}</dd>
        {attempt.failureReason && (
          <>
            <dt>Reason</dt>
            <dd className="small" style={{ color: 'var(--danger)' }}>{attempt.failureReason}</dd>
          </>
        )}
        {attempt.terminationProof && (
          <>
            <dt>Termination</dt>
            <dd className="small" style={{ color: attempt.terminationProof.proven ? undefined : 'var(--danger)' }}>
              {attempt.terminationProof.proven ? '✓ proven — ' : '⚠ NOT proven — '}
              {attempt.terminationProof.detail}
              {attempt.terminationProof.livePids.length > 0 && (
                <span className="mono"> (live pids: {attempt.terminationProof.livePids.join(', ')})</span>
              )}
            </dd>
          </>
        )}
      </dl>

      {operations.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>Operations</h3>
          <div className="row-list small">
            {operations.map((op) => (
              <div className="row-item" key={op.id}>
                <span className="mono">{op.kind}</span>
                <span className="spacer" style={{ flex: 1 }} />
                {op.exitCode !== null && <span className="mono faint">exit {op.exitCode}</span>}
                <span
                  className={`badge ${
                    op.status === 'succeeded' ? 'b-success' : op.status === 'running' ? 'b-accent' : op.status === 'unknown' ? 'b-warning' : 'b-danger'
                  }`}
                >
                  {op.status}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="action-bar" style={{ marginTop: 10 }}>
        {['ready_for_review', 'blocked_reconciliation'].includes(attempt.state) && !attempt.worktreeCleanedAt && (
          <button className="btn sm" disabled={busy} onClick={act(() => api.revalidate(attempt.id))}>
            ↻ Re-run validation only
          </button>
        )}
        {terminal && attempt.worktreePath && !attempt.worktreeCleanedAt && hasCheckpoint && (
          <button className="btn sm" disabled={busy} onClick={act(() => api.cleanupWorktree(attempt.id))}>
            🧹 Remove worktree — work is preserved at checkpoint {attempt.checkpointCommit!.slice(0, 8)} on {attempt.branchName}
          </button>
        )}
        {terminal && attempt.worktreePath && !attempt.worktreeCleanedAt && !hasCheckpoint && (
          <button
            className="btn sm danger"
            disabled={busy}
            onClick={act(async () => {
              if (
                !window.confirm(
                  'This attempt has NO durable checkpoint. Removing the worktree will PERMANENTLY DESTROY any uncommitted work in it (only the empty branch is kept). Discard irreversibly?',
                )
              )
                return;
              await api.cleanupWorktree(attempt.id, true);
            })}
          >
            🗑 Discard worktree — uncommitted work will be LOST
          </button>
        )}
      </div>
      {error && <div className="banner danger" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/** Real evidence: actual changed files, unified diff, validation results. */
export function AttemptEvidence({ attempt }: { attempt: Attempt }) {
  const [showDiff, setShowDiff] = useState(false);
  const ev = attempt.evidence;
  if (!ev) return null;
  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <h3>Real changed files ({ev.changedFiles.length})</h3>
        {ev.changedFiles.length === 0 && <p className="small muted">No files changed.</p>}
        {ev.changedFiles.map((f) => (
          <div className="file-row" key={f.path}>
            <span className={`badge ${f.changeType === 'added' ? 'b-success' : f.changeType === 'deleted' ? 'b-danger' : 'b-info'}`}>
              {f.changeType[0]!.toUpperCase()}
            </span>
            <span className="file-path">{f.path}</span>
            <span className="diff-add">+{f.additions}</span>
            <span className="diff-del">−{f.deletions}</span>
          </div>
        ))}
        {ev.protectedViolations.length > 0 && (
          <div className="banner danger" style={{ marginTop: 8 }}>
            ⛔ Protected paths modified: {ev.protectedViolations.join(', ')}
          </div>
        )}
        {ev.diff && (
          <div style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={() => setShowDiff(!showDiff)}>
              {showDiff ? 'Hide' : 'Show'} git diff{ev.diffTruncated ? ' (truncated)' : ''}
            </button>
            {showDiff && (
              <div className="log-console" style={{ maxHeight: 380, marginTop: 8 }}>
                {ev.diff.split('\n').map((l, i) => (
                  <div
                    className="log-line"
                    key={i}
                    style={{
                      color: l.startsWith('+') ? 'var(--success)' : l.startsWith('-') ? 'var(--danger)' : undefined,
                    }}
                  >
                    {l}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {attempt.validation && (
        <div className="card">
          <h3>Independent validation — {attempt.validation.status}</h3>
          {attempt.validation.steps.length === 0 && (
            <p className="small muted">No validation commands configured for this project; the delivery is UNVERIFIED.</p>
          )}
          {attempt.validation.steps.map((s) => (
            <div key={s.id} style={{ marginBottom: 8 }}>
              <div className="tc-meta">
                <span
                  className={`badge ${s.status === 'PASSED' ? 'b-success' : s.status === 'SKIPPED' ? 'b-neutral' : 'b-danger'}`}
                >
                  {s.status}
                </span>
                <span className="mono small">{s.name}{s.argv.length ? `: ${s.argv.join(' ')}` : ''}</span>
                {s.exitCode !== null && <span className="small faint">exit {s.exitCode}</span>}
                {!s.required && <span className="badge b-outline">optional</span>}
              </div>
              {s.outputTail.length > 0 && s.status !== 'PASSED' && (
                <div className="log-console" style={{ maxHeight: 120, marginTop: 4 }}>
                  {s.outputTail.slice(-8).map((l, i) => (
                    <div className="log-line" key={i}>{l}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {ev.workerLogTail.length > 0 && (
        <div className="card">
          <h3>Worker log tail</h3>
          <div className="log-console" style={{ maxHeight: 160 }}>
            {ev.workerLogTail.map((l, i) => (
              <div className="log-line" key={i}>{l}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
