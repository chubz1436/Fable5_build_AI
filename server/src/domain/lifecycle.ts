import type { TaskStatus } from '../../../shared/types';

/**
 * Task lifecycle state machine.
 *
 *  backlog → ready → awaiting_approval → running → verifying → review → completed
 *                         ↑                │  ↑                   │
 *                         │           paused  │                   │ (changes requested)
 *                         │                │  │                   ▼
 *                         └── (rejected)   └→ blocked ←───────────┘
 *                                              │ retry / reassign → running
 *  cancelled is reachable from every non-terminal state.
 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['ready', 'cancelled'],
  ready: ['awaiting_approval', 'backlog', 'cancelled'],
  awaiting_approval: ['running', 'ready', 'cancelled'],
  running: ['paused', 'blocked', 'verifying', 'cancelled', 'failed'],
  paused: ['running', 'blocked', 'cancelled'],
  // blocked → review covers restart-recovered attempts whose re-validation
  // completes without re-running the worker
  blocked: ['running', 'ready', 'review', 'cancelled', 'failed'],
  verifying: ['review', 'blocked', 'cancelled'],
  review: ['completed', 'blocked', 'cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
};

export const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'cancelled', 'failed'];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new LifecycleError(`Illegal task transition: ${from} → ${to}`);
  }
}

export class LifecycleError extends Error {
  readonly statusCode = 409;
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
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
