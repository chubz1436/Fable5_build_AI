
import { describe, expect, it } from 'vitest';
import type { Approval, Task, TaskDraft } from '../../shared/types';
import { testContext, waitFor } from './helpers';

/**
 * End-to-end owner workflow over the real HTTP API:
 * natural language → structured task → recommendation → approval → run →
 * mid-run approval (high risk) → blocker → retry → verification → evidence →
 * owner accepts. Also covers reassignment/handoff and pause/cancel.
 */
describe('full task flow (API)', () => {
  it('runs the complete high-risk scenario: parse → approve → midrun gate → blocker → retry → review → complete', async () => {
    const { ctx, agent } = testContext();
    const store = ctx.store;

    // 1. natural language → structured draft
    const parse = await agent
      .post('/api/tasks/parse')
      .send({ text: 'Urgent: migrate the Recipe Box database schema to support recipe tags' })
      .expect(200);
    const draft = parse.body as TaskDraft;
    expect(draft.risk).toBe('high');
    expect(draft.priority).toBe('p0');
    expect(draft.projectId).toBe('proj_recipes');
    expect(draft.recommendation.reasons.length).toBeGreaterThan(0);

    // 2. create the task
    const created = await agent.post('/api/tasks').send(draft).expect(201);
    const taskId = (created.body as Task).id;
    expect((created.body as Task).status).toBe('ready');

    // 3. request start → start approval pending
    const reqStart = await agent.post(`/api/tasks/${taskId}/request-start`).send({}).expect(200);
    const startApproval = (reqStart.body as { approval: Approval }).approval;
    expect(startApproval.type).toBe('start');
    expect(store.task(taskId)!.status).toBe('awaiting_approval');

    // 4. owner approves → worker starts
    await agent
      .post(`/api/approvals/${startApproval.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);
    expect(store.task(taskId)!.status).toBe('running');
    const workerId = store.task(taskId)!.assignedWorkerId!;
    expect(store.worker(workerId)!.availability).toBe('busy');

    // 5. high-risk run pauses at the mid-run approval gate
    await waitFor(
      () => store.approvalsForTask(taskId).some((a) => a.type === 'midrun' && a.status === 'pending'),
      'mid-run approval requested',
    );
    const midrun = store.approvalsForTask(taskId).find((a) => a.type === 'midrun')!;
    expect(midrun.affectedScope.length).toBeGreaterThan(0);
    await agent
      .post(`/api/approvals/${midrun.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);

    // 6. first attempt hits a blocker
    await waitFor(() => store.task(taskId)!.status === 'blocked', 'blocker on attempt 1');
    const blocked = store.task(taskId)!;
    expect(blocked.blockReason).toBeTruthy();
    expect(store.worker(workerId)!.availability).toBe('idle');

    // 7. retry → second attempt completes and verification passes
    await agent.post(`/api/tasks/${taskId}/retry`).send({}).expect(200);
    await waitFor(() => store.task(taskId)!.status === 'review', 'review after retry', 15000);
    const reviewed = store.task(taskId)!;
    expect(reviewed.evidence).toBeTruthy();
    expect(reviewed.evidence!.tests.failed).toBe(0);
    expect(reviewed.evidence!.filesChanged.length).toBeGreaterThan(0);
    expect(reviewed.acceptanceCriteria.every((c) => c.met === true)).toBe(true);
    expect(reviewed.attempts).toBe(2);

    // no second mid-run gate on the retry (already approved once)
    const midruns = store.approvalsForTask(taskId).filter((a) => a.type === 'midrun');
    expect(midruns.length).toBe(1);

    // 8. completion approval exists; owner accepts
    const completion = store
      .approvalsForTask(taskId)
      .find((a) => a.type === 'completion' && a.status === 'pending')!;
    expect(completion).toBeTruthy();
    await agent
      .post(`/api/approvals/${completion.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);
    const done = store.task(taskId)!;
    expect(done.status).toBe('completed');
    expect(done.evidence!.finalOwnerAction).toBe('accepted');
    expect(done.completedAt).toBeTruthy();

    // 9. the timeline tells the whole story
    const types = store.eventsForTask(taskId).map((e) => e.type);
    for (const expected of [
      'task.created',
      'worker.recommended',
      'approval.requested',
      'approval.approved',
      'run.started',
      'run.blocked',
      'run.retry',
      'verify.started',
      'verify.passed',
      'review.ready',
      'task.completed',
    ]) {
      expect(types, `timeline should contain ${expected}`).toContain(expected);
    }
  });

  it('hands a blocked task to another worker with structured context', async () => {
    const { ctx, agent } = testContext();
    const store = ctx.store;

    const parse = await agent
      .post('/api/tasks/parse')
      .send({ text: 'Refactor the sensor polling api in the Home Lab Dashboard' })
      .expect(200);
    const draft = parse.body as TaskDraft;
    expect(draft.risk).toBe('medium'); // refactor+api ⇒ blocker on attempt 1

    const created = await agent.post('/api/tasks').send(draft).expect(201);
    const taskId = (created.body as Task).id;

    const reqStart = await agent.post(`/api/tasks/${taskId}/request-start`).send({}).expect(200);
    await agent
      .post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);

    await waitFor(() => store.task(taskId)!.status === 'blocked', 'blocker on attempt 1');
    const fromWorker = store.task(taskId)!.assignedWorkerId!;
    const toWorker = store.workers.find((w) => w.id !== fromWorker && w.availability === 'idle')!.id;

    const reassign = await agent
      .post(`/api/tasks/${taskId}/reassign`)
      .send({ workerId: toWorker, reason: 'Trying a different specialist' })
      .expect(200);
    const handoff = reassign.body.handoff;
    expect(handoff.fromWorkerId).toBe(fromWorker);
    expect(handoff.toWorkerId).toBe(toWorker);
    expect(handoff.context.goal).toBeTruthy();
    expect(handoff.context.completedWork.length).toBeGreaterThan(0);
    expect(handoff.context.remainingWork.length).toBeGreaterThan(0);
    expect(handoff.context.nextAction).toBeTruthy();
    expect(handoff.context.risks.join(' ')).toContain('blocker');

    await waitFor(() => store.task(taskId)!.status === 'review', 'review after handoff', 15000);
    expect(store.task(taskId)!.assignedWorkerId).toBe(toWorker);
    expect(store.task(taskId)!.handoffIds.length).toBe(1);
  });

  it('supports pause, resume and cancel while running', async () => {
    const { ctx, agent } = testContext({ simSpeed: 40 }); // slower so we can pause mid-run
    const store = ctx.store;

    const parse = await agent
      .post('/api/tasks/parse')
      .send({ text: 'Add a settings page to the Home Lab Dashboard' })
      .expect(200);
    const created = await agent.post('/api/tasks').send(parse.body).expect(201);
    const taskId = (created.body as Task).id;

    const reqStart = await agent.post(`/api/tasks/${taskId}/request-start`).send({}).expect(200);
    await agent
      .post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);

    await agent.post(`/api/tasks/${taskId}/pause`).send({}).expect(200);
    expect(store.task(taskId)!.status).toBe('paused');
    const progressAtPause = store.task(taskId)!.progress;
    await new Promise((r) => setTimeout(r, 150));
    expect(store.task(taskId)!.progress).toBe(progressAtPause); // actually paused

    await agent.post(`/api/tasks/${taskId}/resume`).send({}).expect(200);
    expect(store.task(taskId)!.status).toBe('running');

    await agent.post(`/api/tasks/${taskId}/cancel`).send({}).expect(200);
    const cancelled = store.task(taskId)!;
    expect(cancelled.status).toBe('cancelled');
    expect(store.worker(created.body.recommendation.workerId)?.currentTaskId ?? null).toBeNull();

    // cancelled is terminal
    await agent.post(`/api/tasks/${taskId}/retry`).send({}).expect(409);
  });

  it('rejects illegal transitions over the API', async () => {
    const { ctx, agent } = testContext();
    const backlogTask = ctx.store.tasks.find((t) => t.status === 'backlog')!;
    // backlog tasks cannot request start without being promoted first
    await agent.post(`/api/tasks/${backlogTask.id}/request-start`).send({}).expect(409);
    // promote works, then pause (not running) is illegal
    await agent.post(`/api/tasks/${backlogTask.id}/promote`).send({}).expect(200);
    await agent.post(`/api/tasks/${backlogTask.id}/pause`).send({}).expect(409);
    // unknown task
    await agent.post(`/api/tasks/task_nope/retry`).send({}).expect(404);
  });

  it('serves a coherent state snapshot', async () => {
    const { agent } = testContext();
    const res = await agent.get('/api/state').expect(200);
    expect(res.body.projects.length).toBeGreaterThan(0);
    expect(res.body.workers.length).toBe(4);
    expect(res.body.tasks.length).toBeGreaterThan(0);
    expect(res.body.events.length).toBeGreaterThan(0);
    expect(res.body.system.engine).toBe('simulated');
  });
});
