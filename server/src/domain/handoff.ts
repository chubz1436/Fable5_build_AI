import type { Handoff, HandoffContext, Task } from '../../../shared/types';
import type { Store } from '../store/store';
import { nowIso, uid } from './util';

/**
 * Builds the structured context package that travels with a task when it
 * moves from one worker to another. Everything the receiving worker needs
 * to continue without re-deriving state.
 */
export function buildHandoff(
  task: Task,
  fromWorkerId: string,
  toWorkerId: string,
  reason: string,
  store: Store,
): Handoff {
  const plan = task.runPlan ?? [];
  const completedWork = plan.filter((s) => s.done).map((s) => s.label);
  const remainingWork = plan.filter((s) => !s.done).map((s) => s.label);

  const recentLogs = store
    .eventsForTask(task.id)
    .filter((e) => e.type === 'run.log')
    .slice(-5)
    .map((e) => e.message);

  const risks = [`Task risk level: ${task.risk}`];
  if (task.blockReason) risks.push(`Previous blocker: ${task.blockReason}`);

  const nextAction = task.blockReason
    ? `Resolve the blocker (${task.blockReason}) then continue with: ${remainingWork[0] ?? 'verification'}`
    : remainingWork[0] ?? 'Run verification and package evidence';

  const context: HandoffContext = {
    goal: task.goal,
    currentState: task.blockReason
      ? `Blocked at ${task.progress}% during “${task.phase ?? 'execution'}”: ${task.blockReason}`
      : `Handed off at ${task.progress}% during “${task.phase ?? 'execution'}”`,
    completedWork,
    remainingWork,
    filesInScope: task.scope,
    evidenceNotes: recentLogs,
    risks,
    nextAction,
  };

  return {
    id: uid('hoff'),
    taskId: task.id,
    fromWorkerId,
    toWorkerId,
    reason,
    context,
    createdAt: nowIso(),
  };
}
