import { Link } from 'react-router-dom';
import { ApprovalCard } from '../components/ApprovalCard';
import { TaskCard } from '../components/TaskCard';
import { Timeline } from '../components/Timeline';
import { EmptyState, WorkerChip } from '../components/bits';
import { AVAILABILITY_TONE, HEALTH_TONE } from '../lib/format';
import { useStore } from '../lib/store';

export function Dashboard({ onNewTask }: { onNewTask: () => void }) {
  const { tasks, workers, approvals, events, projects } = useStore();

  const active = tasks.filter((t) => ['running', 'verifying', 'paused'].includes(t.status));
  const attention = tasks.filter((t) => ['blocked', 'review'].includes(t.status));
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const completed = tasks.filter((t) => t.status === 'completed');

  return (
    <>
      <div className="topbar">
        <h1>Command Center</h1>
        <span className="spacer" />
        <button className="btn primary" onClick={onNewTask}>＋ New task</button>
      </div>

      <div className="grid stat-grid" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <span className="stat-value">{active.length}</span>
          <span className="stat-label">Active runs</span>
          <span className="stat-hint">{tasks.filter((t) => t.status === 'ready').length} ready to dispatch</span>
        </div>
        <div className="card stat">
          <span className="stat-value" style={{ color: pendingApprovals.length ? 'var(--warning)' : undefined }}>
            {pendingApprovals.length}
          </span>
          <span className="stat-label">Pending approvals</span>
          <span className="stat-hint">waiting on you</span>
        </div>
        <div className="card stat">
          <span className="stat-value" style={{ color: attention.length ? 'var(--danger)' : undefined }}>
            {tasks.filter((t) => t.status === 'blocked').length}
          </span>
          <span className="stat-label">Blocked</span>
          <span className="stat-hint">{tasks.filter((t) => t.status === 'review').length} awaiting review</span>
        </div>
        <div className="card stat">
          <span className="stat-value">{workers.filter((w) => w.health === 'online').length}/{workers.length}</span>
          <span className="stat-label">Workers online</span>
          <span className="stat-hint">{workers.filter((w) => w.availability === 'busy').length} busy</span>
        </div>
        <div className="card stat">
          <span className="stat-value">{completed.length}</span>
          <span className="stat-label">Completed</span>
          <span className="stat-hint">across {projects.length} projects</span>
        </div>
      </div>

      <div className="grid two-col">
        <div className="grid" style={{ gap: 14 }}>
          {pendingApprovals.length > 0 && (
            <section>
              <h3 className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.1em', margin: '0 0 8px' }}>
                Needs your decision
              </h3>
              <div className="grid" style={{ gap: 10 }}>
                {pendingApprovals.slice(0, 3).map((a) => (
                  <ApprovalCard approval={a} key={a.id} />
                ))}
                {pendingApprovals.length > 3 && (
                  <Link to="/approvals" className="small muted">
                    +{pendingApprovals.length - 3} more in Approvals →
                  </Link>
                )}
              </div>
            </section>
          )}

          <section>
            <h3 className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.1em', margin: '0 0 8px' }}>
              In motion
            </h3>
            {active.length + attention.length === 0 ? (
              <EmptyState>
                Nothing running. Create a task and dispatch a worker to see the pipeline move.
              </EmptyState>
            ) : (
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                {[...active, ...attention].map((t) => (
                  <TaskCard task={t} key={t.id} showStatus />
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <h3>Worker roster</h3>
            <div className="row-list">
              {workers.map((w) => (
                <div className="row-item" key={w.id}>
                  <WorkerChip workerId={w.id} />
                  <span className="small faint">{w.role}</span>
                  <span className="spacer" style={{ flex: 1 }} />
                  <span className={`badge dot ${AVAILABILITY_TONE[w.availability]}`}>{w.availability}</span>
                  <span className={`badge ${HEALTH_TONE[w.health]}`}>{w.health}</span>
                </div>
              ))}
            </div>
            <Link to="/workers" className="small muted">Full roster →</Link>
          </section>
        </div>

        <div className="card">
          <h3>Recent activity</h3>
          <Timeline events={[...events].reverse()} limit={14} />
          <Link to="/activity" className="small muted">Full activity log →</Link>
        </div>
      </div>
    </>
  );
}
