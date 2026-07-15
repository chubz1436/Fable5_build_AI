import type { Priority, RiskLevel, TaskStatus, WorkerAvailability, WorkerHealth } from '../../../shared/types';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  awaiting_approval: 'Awaiting Approval',
  running: 'Running',
  paused: 'Paused',
  blocked: 'Blocked',
  verifying: 'Verifying',
  review: 'Review',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const STATUS_TONE: Record<TaskStatus, string> = {
  backlog: 'b-neutral',
  ready: 'b-info',
  awaiting_approval: 'b-warning',
  running: 'b-accent',
  paused: 'b-warning',
  blocked: 'b-danger',
  verifying: 'b-accent',
  review: 'b-success',
  completed: 'b-success',
  cancelled: 'b-neutral',
  failed: 'b-danger',
};

export const RISK_TONE: Record<RiskLevel, string> = {
  low: 'b-success',
  medium: 'b-warning',
  high: 'b-danger',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  p0: 'P0 · Urgent',
  p1: 'P1 · High',
  p2: 'P2 · Normal',
  p3: 'P3 · Low',
};

export const AVAILABILITY_TONE: Record<WorkerAvailability, string> = {
  idle: 'b-success',
  busy: 'b-accent',
  paused: 'b-warning',
  offline: 'b-neutral',
};

export const HEALTH_TONE: Record<WorkerHealth, string> = {
  online: 'b-success',
  degraded: 'b-warning',
  offline: 'b-danger',
};

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
