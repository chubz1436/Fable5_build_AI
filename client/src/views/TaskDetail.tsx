import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { EventRecord, OperationRecord, Task } from '../../../shared/types';
import { ApprovalCard } from '../components/ApprovalCard';
import { AttemptEvidence, AttemptPanel } from '../components/AttemptPanel';
import { EvidencePanel } from '../components/EvidencePanel';
import { LogConsole, Timeline } from '../components/Timeline';
import {
  EmptyState,
  PriorityBadge,
  ProgressBar,
  ProjectTag,
  RiskBadge,
  StatusBadge,
  WorkerChip,
} from '../components/bits';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useLookups, useStore } from '../lib/store';

export function TaskDetail() {
  const { id = '' } = useParams();
  const store = useStore();
  const { workerById } = useLookups();

  const [historicEvents, setHistoricEvents] = useState<EventRecord[]>([]);
  const [operations, setOperations] = useState<OperationRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reassignTo, setReassignTo] = useState('');
  const [dispatchTo, setDispatchTo] = useState('');

  const task: Task | undefined = store.tasks.find((t) => t.id === id);
  const taskStatus = task?.status;

  useEffect(() => {
    let gone = false;
    api
      .taskDetail(id)
      .then((d) => {
        if (gone) return;
        setHistoricEvents(d.events);
        setOperations(d.operations);
      })
      .catch((e) => !gone && setError((e as Error).message));
    return () => {
      gone = true;
    };
  }, [id, taskStatus]);

  /** historic (oldest-first) + live events that arrived after bootstrap */
  const events = useMemo(() => {
    const seen = new Set(historicEvents.map((e) => e.id));
    const live = [...store.events].reverse().filter((e) => e.taskId === id && !seen.has(e.id));
    return [...historicEvents, ...live];
  }, [historicEvents, store.events, id]);

  const approvals = store.approvals.filter((a) => a.taskId === id);
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const handoffs = store.handoffs.filter((h) => h.taskId === id);
  const taskAttempts = store.attempts.filter((a) => a.taskId === id);
  const latestAttempt = taskAttempts[taskAttempts.length - 1];

  if (!store.loaded) return <EmptyState>Loading…</EmptyState>;
  if (!task) {
    return (
      <EmptyState>
        Task not found. <Link to="/board" style={{ textDecoration: 'underline' }}>Back to board</Link>
      </EmptyState>
    );
  }

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

  const idleWorkers = store.workers.filter(
    (w) => w.availability === 'idle' && w.id !== task.assignedWorkerId,
  );
  const isActive = ['running', 'verifying', 'paused'].includes(task.status);

  return (
    <>
      <div className="detail-head">
        <Link to="/board" className="small muted">← Task board</Link>
        <div className="detail-title-row">
          <h1>{task.title}</h1>
          <StatusBadge status={task.status} />
        </div>
        <div className="tc-meta">
          <ProjectTag projectId={task.projectId} />
          <RiskBadge risk={task.risk} />
          <PriorityBadge priority={task.priority} />
          <span className="badge b-outline">attempt {task.attempts}</span>
          <WorkerChip workerId={task.assignedWorkerId} fallback="unassigned" />
          <span className="small faint">created {timeAgo(task.createdAt)}</span>
        </div>

        {/* contextual actions */}
        <div className="action-bar">
          {task.status === 'backlog' && (
            <button className="btn primary" disabled={busy} onClick={act(() => api.promote(task.id))}>
              Promote to Ready
            </button>
          )}
          {task.status === 'ready' && (
            <>
              <button
                className="btn primary"
                disabled={busy}
                onClick={act(() => api.requestStart(task.id, dispatchTo || undefined))}
              >
                ▶ Dispatch worker
              </button>
              <select
                className="note-input"
                style={{ flex: 'none' }}
                value={dispatchTo}
                onChange={(e) => setDispatchTo(e.target.value)}
              >
                <option value="">
                  {workerById(task.recommendation?.workerId)?.name ?? 'Auto'} (recommended)
                </option>
                {store.workers
                  .filter((w) => w.id !== task.recommendation?.workerId)
                  .map((w) => (
                    <option key={w.id} value={w.id}>{w.avatar} {w.name}</option>
                  ))}
              </select>
            </>
          )}
          {task.status === 'running' &&
            !task.gitProjectId &&
            workerById(task.assignedWorkerId)?.adapter === 'simulated' && (
              <button className="btn warning" disabled={busy} onClick={act(() => api.pause(task.id))}>
                ⏸ Pause
              </button>
            )}
          {task.status === 'paused' && (
            <button className="btn primary" disabled={busy} onClick={act(() => api.resume(task.id))}>
              ▶ Resume
            </button>
          )}
          {task.status === 'blocked' && (
            <button className="btn primary" disabled={busy} onClick={act(() => api.retry(task.id))}>
              ↻ Retry (attempt {task.attempts + 1})
            </button>
          )}
          {['blocked', 'paused'].includes(task.status) && !task.gitProjectId && idleWorkers.length > 0 && (
            <>
              <select
                className="note-input"
                style={{ flex: 'none' }}
                value={reassignTo}
                onChange={(e) => setReassignTo(e.target.value)}
              >
                <option value="">Hand off to…</option>
                {idleWorkers.map((w) => (
                  <option key={w.id} value={w.id}>{w.avatar} {w.name}</option>
                ))}
              </select>
              <button
                className="btn"
                disabled={busy || !reassignTo}
                onClick={act(() => api.reassign(task.id, reassignTo, 'Owner reassignment'))}
              >
                ⇄ Reassign
              </button>
            </>
          )}
          {!['completed', 'cancelled', 'failed'].includes(task.status) && (
            <button className="btn danger" disabled={busy} onClick={act(() => api.cancel(task.id))}>
              ✕ Cancel task
            </button>
          )}
        </div>

        {error && <div className="banner danger">{error}</div>}
        {task.status === 'blocked' && task.blockReason && (
          <div className="banner danger">⛔ {task.blockReason}</div>
        )}
        {pendingApprovals.length > 0 && (
          <div className="banner warning">
            ⏳ Waiting on your decision below — execution is held until you approve or reject.
          </div>
        )}
      </div>

      {isActive && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="small muted">{task.phase ?? 'Working…'}</span>
            <span className="small mono">{task.progress}%</span>
          </div>
          <ProgressBar value={task.progress} />
        </div>
      )}

      {pendingApprovals.map((a) => (
        <div style={{ marginBottom: 14 }} key={a.id}>
          <ApprovalCard approval={a} />
        </div>
      ))}

      <div className="grid two-col">
        <div className="grid" style={{ gap: 14 }}>
          {task.gitProjectId && latestAttempt?.evidence ? (
            <AttemptEvidence attempt={latestAttempt} />
          ) : (task.status === 'review' || task.status === 'completed') && task.evidence ? (
            <EvidencePanel evidence={task.evidence} />
          ) : (
            <div className="card">
              <h3>Goal</h3>
              <p style={{ margin: 0, fontStyle: 'italic' }} className="muted">“{task.goal}”</p>
            </div>
          )}

          {task.runPlan && task.status !== 'completed' && (
            <div className="card">
              <h3>Worker plan</h3>
              <ul className="plan">
                {task.runPlan.map((s) => {
                  const isCurrent = !s.done && task.phase === s.label && isActive;
                  return (
                    <li key={s.id} className={s.done ? 'done' : isCurrent ? 'current' : ''}>
                      <span className="plan-mark">{s.done ? '[✓]' : isCurrent ? '[▶]' : '[ ]'}</span>
                      {s.label}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="card">
            <h3>Acceptance criteria</h3>
            <ul className="criteria">
              {task.acceptanceCriteria.map((c) => (
                <li key={c.id}>
                  <span
                    className="crit-mark"
                    style={{ color: c.met ? 'var(--success)' : 'var(--faint)' }}
                  >
                    {c.met ? '✓' : '○'}
                  </span>
                  {c.text}
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h3>Worker output</h3>
            <LogConsole events={events} />
          </div>
        </div>

        <div className="grid" style={{ gap: 14 }}>
          {task.gitProjectId && latestAttempt && (
            <AttemptPanel attempt={latestAttempt} operations={operations} />
          )}
          {task.recommendation && (
            <div className="card">
              <h3>Routing decision</h3>
              <div style={{ marginBottom: 8 }}>
                <WorkerChip workerId={task.recommendation.workerId} />
              </div>
              <ul className="criteria" style={{ marginBottom: 10 }}>
                {task.recommendation.reasons.map((r, i) => (
                  <li key={i}><span className="crit-mark" style={{ color: 'var(--accent)' }}>›</span> {r}</li>
                ))}
              </ul>
              <div className="row-list small">
                {task.recommendation.scores.map((s) => (
                  <div className="row-item" key={s.workerId} title={s.factors.join('\n')}>
                    <WorkerChip workerId={s.workerId} />
                    <span className="spacer" style={{ flex: 1 }} />
                    <span className="mono muted">{s.score} pts</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {handoffs.length > 0 && (
            <div className="card">
              <h3>Handoffs</h3>
              {handoffs.map((h) => (
                <div key={h.id} style={{ marginBottom: 10 }}>
                  <div className="tc-meta" style={{ marginBottom: 6 }}>
                    <WorkerChip workerId={h.fromWorkerId} />
                    <span className="faint">→</span>
                    <WorkerChip workerId={h.toWorkerId} />
                  </div>
                  <dl className="kv">
                    <dt>Reason</dt>
                    <dd>{h.reason}</dd>
                    <dt>State at handoff</dt>
                    <dd>{h.context.currentState}</dd>
                    <dt>Completed</dt>
                    <dd>{h.context.completedWork.length} step(s)</dd>
                    <dt>Remaining</dt>
                    <dd>{h.context.remainingWork.join('; ') || '—'}</dd>
                    <dt>Next action</dt>
                    <dd>{h.context.nextAction}</dd>
                    <dt>Risks</dt>
                    <dd>{h.context.risks.join('; ')}</dd>
                  </dl>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <h3>Timeline</h3>
            <Timeline events={events} />
          </div>
        </div>
      </div>
    </>
  );
}
