import type {
  Approval,
  Attempt,
  EventRecord,
  Handoff,
  OperationRecord,
  Project,
  StateSnapshot,
  Task,
  TaskDraft,
} from '../../../shared/types';

/** thrown for 401s so the shell can show the sign-in instructions */
export class AuthRequiredError extends Error {}

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new AuthRequiredError((body as { error?: string }).error ?? 'Authentication required.');
  }
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
  attempts: Attempt[];
  operations: OperationRecord[];
}

export interface ValidationCommandInput {
  name: string;
  argv: string[];
  required?: boolean;
  timeoutMs?: number;
}

export const api = {
  state: () => req<StateSnapshot>('/state'),
  parse: (text: string, projectId?: string) =>
    req<TaskDraft>('/tasks/parse', { method: 'POST', body: JSON.stringify({ text, projectId }) }),
  createTask: (draft: Partial<TaskDraft> & { title: string; goal: string; projectId: string }) =>
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
  retry: (id: string) =>
    req<Task | { task: Task; approval: Approval }>(`/tasks/${id}/retry`, { method: 'POST', body: '{}' }),
  reassign: (id: string, workerId: string, reason?: string) =>
    req<{ task: Task; handoff: Handoff }>(`/tasks/${id}/reassign`, {
      method: 'POST',
      body: JSON.stringify({ workerId, reason }),
    }),

  // -- git project registry ---------------------------------------------------
  registerProject: (input: {
    name: string;
    repoRoot: string;
    baseBranch?: string;
    validationCommands?: ValidationCommandInput[];
    protectedPaths?: string[];
  }) => req<Project>('/projects/register', { method: 'POST', body: JSON.stringify(input) }),
  recheckProject: (id: string) => req<Project>(`/projects/${id}/recheck`, { method: 'POST', body: '{}' }),
  updateProject: (
    id: string,
    patch: { enabled?: boolean; validationCommands?: ValidationCommandInput[]; protectedPaths?: string[] },
  ) => req<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // -- attempts -----------------------------------------------------------------
  attemptDetail: (id: string) => req<{ attempt: Attempt; operations: OperationRecord[] }>(`/attempts/${id}`),
  revalidate: (id: string) => req<Attempt>(`/attempts/${id}/revalidate`, { method: 'POST', body: '{}' }),
  cleanupWorktree: (id: string, confirmDiscard = false) =>
    req<Attempt>(`/attempts/${id}/cleanup`, { method: 'POST', body: JSON.stringify({ confirmDiscard }) }),
};
