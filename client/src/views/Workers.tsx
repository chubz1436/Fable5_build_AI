import { Link } from 'react-router-dom';
import { AVAILABILITY_TONE, HEALTH_TONE } from '../lib/format';
import { useLookups, useStore } from '../lib/store';

export function Workers() {
  const { workers } = useStore();
  const { taskById } = useLookups();
  const realCount = workers.filter((w) => w.integration === 'real').length;
  return (
    <>
      <div className="topbar">
        <h1>Worker roster</h1>
        <span className="spacer" />
        <span className={`badge ${realCount ? 'b-success' : 'b-outline'}`}>
          {realCount
            ? `${realCount} real adapter${realCount > 1 ? 's' : ''} active — others simulated`
            : 'all execution is simulated — real adapters plug in later'}
        </span>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {workers.map((w) => {
          const current = w.currentTaskId ? taskById(w.currentTaskId) : undefined;
          return (
            <div className="card worker-card" key={w.id}>
              <div className="worker-head">
                <span className="avatar-lg">{w.avatar}</span>
                <div>
                  <div style={{ fontWeight: 650 }}>{w.name}</div>
                  <div className="small muted">{w.role}</div>
                  <div className="small faint mono">{w.provider} · {w.model}</div>
                </div>
              </div>
              <div className="tc-meta">
                <span className={`badge dot ${AVAILABILITY_TONE[w.availability]}`}>{w.availability}</span>
                <span className={`badge ${HEALTH_TONE[w.health]}`}>{w.health}</span>
                <span className="badge b-outline">{w.completedTaskCount} completed</span>
                <span className={`badge ${w.integration === 'real' ? 'b-success' : 'b-outline'}`}>
                  {w.integration === 'real' ? `REAL · ${w.adapter}` : `adapter: ${w.adapter}`}
                </span>
              </div>
              <div>
                <div className="small faint" style={{ marginBottom: 4 }}>Strengths</div>
                <div className="tag-row">
                  {w.strengths.map((s) => (
                    <span className="badge b-accent" key={s}>{s}</span>
                  ))}
                  {w.traits.map((t) => (
                    <span className="badge b-outline" key={t}>{t}</span>
                  ))}
                </div>
              </div>
              {current ? (
                <div className="banner info small">
                  Working on&nbsp;<Link to={`/tasks/${current.id}`} style={{ textDecoration: 'underline' }}>{current.title}</Link>
                </div>
              ) : (
                <span className="small faint">No current task</span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
