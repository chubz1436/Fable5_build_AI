import { ApprovalCard } from '../components/ApprovalCard';
import { EmptyState } from '../components/bits';
import { useStore } from '../lib/store';

export function Approvals() {
  const { approvals } = useStore();
  const pending = approvals.filter((a) => a.status === 'pending');
  const decided = approvals
    .filter((a) => a.status !== 'pending')
    .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));

  return (
    <>
      <div className="topbar">
        <h1>Approvals</h1>
        <span className="spacer" />
        {pending.length > 0 && <span className="badge b-warning">{pending.length} pending</span>}
      </div>

      <div className="grid" style={{ maxWidth: 860, gap: 12 }}>
        {pending.length === 0 ? (
          <EmptyState>Nothing waiting on you. Approvals appear here when workers need a decision.</EmptyState>
        ) : (
          pending.map((a) => <ApprovalCard approval={a} key={a.id} />)
        )}

        {decided.length > 0 && (
          <>
            <h3 className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.1em', margin: '14px 0 0' }}>
              History
            </h3>
            {decided.slice(0, 20).map((a) => (
              <ApprovalCard approval={a} key={a.id} />
            ))}
          </>
        )}
      </div>
    </>
  );
}
