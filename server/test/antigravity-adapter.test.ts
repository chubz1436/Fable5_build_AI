import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { Approval, Task, TaskDraft } from '../../shared/types';
import { testContext, waitFor } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = `"${process.execPath}" "${path.join(here, 'fixtures', 'fake-agy.mjs')}"`;

describe('antigravity adapter end-to-end (fake CLI)', () => {
  it('runs a real Antigravity task: agy --print → plain-text logs → workspace evidence → owner review', async () => {
    const { ctx, agent, dataDir } = testContext({ antigravityCommand: FAKE_CLI });
    const store = ctx.store;

    const worker = store.worker('wkr_antigravity')!;
    worker.adapter = 'antigravity';
    worker.integration = 'real';
    store.upsertWorker(worker);

    const parse = await agent
      .post('/api/tasks/parse')
      .send({ text: 'Add a notes markdown file to the Recipe Box' })
      .expect(200);
    const created = await agent
      .post('/api/tasks')
      .send(parse.body as TaskDraft)
      .expect(201);
    const taskId = (created.body as Task).id;

    const reqStart = await agent
      .post(`/api/tasks/${taskId}/request-start`)
      .send({ workerId: 'wkr_antigravity' })
      .expect(200);
    await agent
      .post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);
    expect(store.task(taskId)!.status).toBe('running');

    // real CLI processes can't be paused — the engine refuses honestly
    const pauseRes = await agent.post(`/api/tasks/${taskId}/pause`).send({});
    expect(pauseRes.status).toBe(409);
    expect(pauseRes.body.error).toContain('cannot be paused');

    await waitFor(() => store.task(taskId)!.status === 'review', 'review after fake agy run', 15000);
    const task = store.task(taskId)!;

    const notes = task.evidence!.filesChanged.find((f) => f.path === 'notes.md');
    expect(notes?.changeType).toBe('added');
    expect(notes!.additions).toBeGreaterThan(0);
    // brief file is never surfaced as evidence
    expect(task.evidence!.filesChanged.some((f) => f.path.includes('_TASK_BRIEF'))).toBe(false);
    expect(task.evidence!.summary).toBe('Created notes.md with a short heading and bullet');
    expect(task.evidence!.workPerformed).toContain('Wrote notes.md');

    // file genuinely exists in the isolated workspace
    const wsFile = path.join(dataDir, 'workspaces', taskId, 'notes.md');
    expect(fs.existsSync(wsFile)).toBe(true);
    expect(fs.readFileSync(wsFile, 'utf8')).toContain('created by antigravity');

    // no automated verification → criteria left for the owner
    expect(task.acceptanceCriteria.every((c) => c.met === null)).toBe(true);

    // plain-text session captured in the live console
    const logs = store.eventsForTask(taskId).filter((e) => e.type === 'run.log');
    expect(logs.some((e) => e.message.includes('Antigravity session started'))).toBe(true);
    expect(logs.some((e) => e.message.includes('Created notes.md in the workspace'))).toBe(true);

    const completion = store
      .approvalsForTask(taskId)
      .find((a) => a.type === 'completion' && a.status === 'pending')!;
    expect(completion.recommendationReason).toContain('no automated verification');
    await agent
      .post(`/api/approvals/${completion.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);
    expect(store.task(taskId)!.status).toBe('completed');
  });

  it('blocks with a clear reason when the Antigravity CLI cannot launch', async () => {
    const { ctx, agent } = testContext({
      antigravityCommand: '"definitely-not-agy-xyz"',
      antigravityTimeoutMs: 5000,
    });
    const store = ctx.store;
    const worker = store.worker('wkr_antigravity')!;
    worker.adapter = 'antigravity';
    store.upsertWorker(worker);

    const parse = await agent.post('/api/tasks/parse').send({ text: 'Write a note file' }).expect(200);
    const created = await agent.post('/api/tasks').send(parse.body).expect(201);
    const taskId = (created.body as Task).id;
    const reqStart = await agent
      .post(`/api/tasks/${taskId}/request-start`)
      .send({ workerId: 'wkr_antigravity' })
      .expect(200);
    await agent
      .post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);

    await waitFor(() => store.task(taskId)!.status === 'blocked', 'blocked on launch failure', 10000);
    expect(store.task(taskId)!.blockReason).toMatch(/exited with code|Could not launch|no changes/i);
    expect(store.worker('wkr_antigravity')!.availability).toBe('idle');
  });
});
