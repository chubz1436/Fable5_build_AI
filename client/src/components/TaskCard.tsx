import { useNavigate } from 'react-router-dom';
import type { Task } from '../../../shared/types';
import {
  ProgressBar,
  ProjectTag,
  RiskBadge,
  StatusBadge,
  WorkerChip,
} from './bits';

export function TaskCard({ task, showStatus }: { task: Task; showStatus?: boolean }) {
  const navigate = useNavigate();
  const active = ['running', 'verifying', 'paused'].includes(task.status);
  return (
    <div
      className="task-card"
      onClick={() => navigate(`/tasks/${task.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/tasks/${task.id}`)}
    >
      <ProjectTag projectId={task.projectId} />
      <div className="tc-title">{task.title}</div>
      {active && (
        <>
          <ProgressBar value={task.progress} />
          {task.phase && <span className="small muted">{task.phase}</span>}
        </>
      )}
      {task.status === 'blocked' && task.blockReason && (
        <span className="small" style={{ color: 'var(--danger)' }}>
          ⛔ {task.blockReason}
        </span>
      )}
      <div className="tc-footer">
        <div className="tc-meta">
          {showStatus && <StatusBadge status={task.status} />}
          <RiskBadge risk={task.risk} />
          <span className="badge b-outline">{task.priority.toUpperCase()}</span>
        </div>
        <WorkerChip workerId={task.assignedWorkerId} />
      </div>
    </div>
  );
}
