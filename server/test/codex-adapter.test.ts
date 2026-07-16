import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { Approval, Task, TaskDraft } from '../../shared/types';
import { testContext, waitFor } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = `"${process.execPath}" "${path.join(here, 'fixtures', 'fake-codex.mjs')}"`;

describe('codex adapter end-to-end (fake CLI)', () => {
  it('runs a real Codex task: exec --json → live logs → workspace evidence → owner review', async () => {
    const { ctx, agent, dataDir } = testContext({ codexCommand: FAKE_CLI });
    const store = ctx.store;

    // promote the Codex worker to the real adapter (what boot detection does)
    const worker = store.worker('wkr_codex')!;
    worker.adapter = 'codex';
    worker.integration = 'real';
    store.upsertWorker(worker);

    const parse = await agent
      .post('/api/tasks/parse')
      .send({ text: 'Add a greeting script to the Recipe Box' })
      .expect(200);
    const created = await agent
      .post('/api/tasks')
      .send(parse.body as TaskDraft)
      .expect(201);
    const taskId = (created.body as Task).id;

    const reqStart = await agent
      .post(`/api/tasks/${taskId}/request-start`)
      .send({ workerId: 'wkr_codex' })
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

    await waitFor(() => store.task(taskId)!.status === 'review', 'review after fake codex run', 15000);
    const task = store.task(taskId)!;

    // evidence from a real workspace diff
    const greet = task.evidence!.filesChanged.find((f) => f.path === 'greet.py');
    expect(greet?.changeType).toBe('added');
    expect(greet!.additions).toBeGreaterThan(0);
    // brief file is never surfaced as evidence
    expect(task.evidence!.filesChanged.some((f) => f.path.includes('_TASK_BRIEF'))).toBe(false);
    // summary + work come from the -o final message json block
    expect(task.evidence!.summary).toBe('Created greet.py that prints a greeting');
    expect(task.evidence!.workPerformed).toContain('Ran python greet.py');

    // the file genuinely exists in the isolated workspace; lastmsg sink does not pollute it
    const wsFile = path.join(dataDir, 'workspaces', taskId, 'greet.py');
    expect(fs.existsSync(wsFile)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'workspaces', `${taskId}.lastmsg.txt`))).toBe(false);

    // no automated verification → criteria left for the owner
    expect(task.acceptanceCriteria.every((c) => c.met === null)).toBe(true);

    // live console captured the streamed session (a command + a file edit)
    const logs = store.eventsForTask(taskId).filter((e) => e.type === 'run.log');
    expect(logs.some((e) => e.message.includes('Codex session started'))).toBe(true);
    expect(logs.some((e) => e.message.includes('⚙ python greet.py'))).toBe(true);

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

  it('blocks with a clear reason when the Codex CLI cannot launch', async () => {
    const { ctx, agent } = testContext({
      codexCommand: '"definitely-not-codex-xyz"',
      codexTimeoutMs: 5000,
    });
    const store = ctx.store;
    const worker = store.worker('wkr_codex')!;
    worker.adapter = 'codex';
    store.upsertWorker(worker);

    const parse = await agent.post('/api/tasks/parse').send({ text: 'Write a note file' }).expect(200);
    const created = await agent.post('/api/tasks').send(parse.body).expect(201);
    const taskId = (created.body as Task).id;
    const reqStart = await agent
      .post(`/api/tasks/${taskId}/request-start`)
      .send({ workerId: 'wkr_codex' })
      .expect(200);
    await agent
      .post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);

    await waitFor(() => store.task(taskId)!.status === 'blocked', 'blocked on launch failure', 10000);
    expect(store.task(taskId)!.blockReason).toMatch(/exited with code|Could not launch/);
    expect(store.worker('wkr_codex')!.availability).toBe('idle');
  });
});
