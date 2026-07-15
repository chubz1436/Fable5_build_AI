import type {
  Approval,
  EventRecord,
  Handoff,
  StateSnapshot,
  Task,
  TaskDraft,
} from '../../../shared/types';

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export interface TaskDetail {
  task: Task;
  events: EventRecord[];
  approvals: Approval[];
  handoffs: Handoff[];
}

export const api = {
  state: () => req<StateSnapshot>('/state'),
  parse: (text: string, projectId?: string) =>
    req<TaskDraft>('/tasks/parse', { method: 'POST', body: JSON.stringify({ text, projectId }) }),
  createTask: (draft: TaskDraft) =>
    req<Task>('/tasks', { method: 'POST', body: JSON.stringify(draft) }),
  taskDetail: (id: string) => req<TaskDetail>(`/tasks/${id}`),
  promote: (id: string) => req<Task>(`/tasks/${id}/promote`, { method: 'POST', body: '{}' }),
  requestStart: (id: string, workerId?: string) =>
    req<{ task: Task; approval: Approval }>(`/tasks/${id}/request-start`, {
      method: 'POST',
      body: JSON.stringify({ workerId }),
    }),
  decide: (approvalId: string, decision: 'approve' | 'reject', note?: string) =>
    req<Approval>(`/approvals/${approvalId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, note: note || undefined }),
    }),
  pause: (id: string) => req<Task>(`/tasks/${id}/pause`, { method: 'POST', body: '{}' }),
  resume: (id: string) => req<Task>(`/tasks/${id}/resume`, { method: 'POST', body: '{}' }),
  cancel: (id: string) => req<Task>(`/tasks/${id}/cancel`, { method: 'POST', body: '{}' }),
  retry: (id: string) => req<Task>(`/tasks/${id}/retry`, { method: 'POST', body: '{}' }),
  reassign: (id: string, workerId: string, reason?: string) =>
    req<{ task: Task; handoff: Handoff }>(`/tasks/${id}/reassign`, {
      method: 'POST',
      body: JSON.stringify({ workerId, reason }),
    }),
};
