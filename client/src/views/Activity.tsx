import { useState } from 'react';
import { Timeline } from '../components/Timeline';
import { useStore } from '../lib/store';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'approval', label: 'Approvals' },
  { key: 'run', label: 'Execution' },
  { key: 'task', label: 'Tasks' },
  { key: 'handoff', label: 'Handoffs' },
] as const;

export function Activity() {
  const { events } = useStore();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');

  const filtered = filter === 'all' ? events : events.filter((e) => e.type.startsWith(filter));

  return (
    <>
      <div className="topbar">
        <h1>Activity</h1>
        <span className="spacer" />
        <div className="tc-meta">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`btn sm ${filter === f.key ? 'primary' : 'ghost'}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="card" style={{ maxWidth: 860 }}>
        <Timeline events={[...filtered].reverse()} limit={120} />
      </div>
    </>
  );
}
