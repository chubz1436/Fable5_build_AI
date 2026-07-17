import { describe, expect, it } from 'vitest';
import type { Approval, Project, StreamMessage, Task } from '../../shared/types';
import { makeTempGitRepo, testContext, waitFor } from './helpers';

/**
 * P0-6 audit reproduction: a lease conflict rolled the database back (HTTP
 * 409) but SSE had already broadcast an approved grant and a new attempt.
 * Now Store broadcasts are buffered while a transaction is open, published
 * only after the outer COMMIT, and discarded entirely on ROLLBACK.
 */
describe('SSE broadcasts are transactional (P0-6)', () => {
  it('a rolled-back transaction emits NO messages; a committed one emits after COMMIT', () => {
    const { ctx } = testContext();
    const store = ctx.store;
    const seen: StreamMessage[] = [];
    store.emitter.on('message', (m: StreamMessage) => seen.push(m));

    const task = store.tasks[0]!;

    // rollback: the upsert inside the tx must never reach subscribers
    expect(() =>
      store.tx(() => {
        task.title = 'PHANTOM TITLE';
        store.upsertTask(task);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(seen).toEqual([]);

    // commit: messages arrive only after the tx completes
    let during = -1;
    store.tx(() => {
      store.upsertTask(task);
      during = seen.length; // still buffered at this point
    });
    expect(during).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]!.kind).toBe('task');
  });

  it('a lease-conflict rollback (409) broadcasts no phantom approval/attempt/task/worker events', async () => {
    const { ctx, agent } = testContext();
    const repo = makeTempGitRepo();
    const project = (
      await agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo }).expect(201)
    ).body as Project;
    const mk = async (goal: string) =>
      (await agent.post('/api/tasks').send({ title: goal.slice(0, 30), goal, projectId: project.id }).expect(201))
        .body as Task;
    const t1 = await mk('Slow one [[SLOW]]');
    const t2 = await mk('Conflicting second');
    const a1 = (
      (await agent.post(`/api/tasks/${t1.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as {
        approval: Approval;
      }
    ).approval;
    const a2 = (
      (await agent.post(`/api/tasks/${t2.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as {
        approval: Approval;
      }
    ).approval;

    await agent.post(`/api/approvals/${a1.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => ctx.store.attemptsForTask(t1.id)[0]?.state === 'running', 't1 running', 20000);

    // subscribe just before the conflicting decision
    const seen: StreamMessage[] = [];
    const listener = (m: StreamMessage) => seen.push(m);
    ctx.store.emitter.on('message', listener);
    const res = await agent.post(`/api/approvals/${a2.id}/decision`).send({ decision: 'approve' });
    ctx.store.emitter.off('message', listener);
    expect(res.status).toBe(409);

    // no phantom state ever reached subscribers
    for (const m of seen) {
      if (m.kind === 'approval') expect(m.approval.id, 'phantom approved grant broadcast').not.toBe(a2.id);
      if (m.kind === 'attempt') expect(m.attempt.taskId, 'phantom attempt broadcast').not.toBe(t2.id);
      if (m.kind === 'task') expect(`${m.task.id}:${m.task.status}`).not.toBe(`${t2.id}:running`);
      if (m.kind === 'worker') expect(m.worker.currentTaskId).not.toBe(t2.id);
    }
    // and the database agrees with what subscribers saw
    expect(ctx.store.approval(a2.id)!.status).toBe('pending');
    expect(ctx.store.attemptsForTask(t2.id)).toEqual([]);
    expect(ctx.store.task(t2.id)!.status).toBe('awaiting_approval');
  });
});
