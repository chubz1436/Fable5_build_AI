import type { ReactNode } from 'react';
import type { Priority, RiskLevel, TaskStatus } from '../../../shared/types';
import {
  PRIORITY_LABEL,
  RISK_TONE,
  STATUS_LABEL,
  STATUS_TONE,
} from '../lib/format';
import { useLookups } from '../lib/store';

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`badge dot ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return <span className={`badge ${RISK_TONE[risk]}`}>risk: {risk}</span>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className="badge b-outline">{PRIORITY_LABEL[priority]}</span>;
}

export function WorkerChip({ workerId, fallback }: { workerId: string | null | undefined; fallback?: string }) {
  const { workerById } = useLookups();
  const worker = workerById(workerId);
  if (!worker) return fallback ? <span className="worker-chip faint">{fallback}</span> : null;
  return (
    <span className="worker-chip" title={`${worker.name} — ${worker.role}`}>
      <span className="avatar">{worker.avatar}</span>
      {worker.name}
    </span>
  );
}

export function ProjectTag({ projectId }: { projectId: string }) {
  const { projectById } = useLookups();
  const project = projectById(projectId);
  if (!project) return null;
  return (
    <span className="tc-project">
      <span className="swatch" style={{ background: project.color }} />
      {project.name}
    </span>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
