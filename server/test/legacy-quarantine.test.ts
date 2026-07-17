import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { Approval, Task, TaskDraft } from '../../shared/types';
import { loadConfig } from '../src/config';
import { testContext, waitFor } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = `"${process.execPath}" "${path.join(here, 'fixtures', 'fake-codex.mjs')}"`;

/**
 * P0-5: the legacy Engine path is quarantined. Sample (non-git) tasks ALWAYS
 * execute on the SimulatedAdapter — even when a worker was upgraded to a real
 * CLI adapter by boot detection — and no real CLI is ever spawned for them.
 */
describe('legacy real-adapter quarantine (P0-5)', () => {
  it('sample tasks never spawn a real CLI, even with a real adapter configured', async () => {
    const { ctx, agent, dataDir } = testContext({ codexCommand: FAKE_CLI });
    const store = ctx.store;

    // simulate boot detection upgrading the worker to a real adapter
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
    expect((created.body as Task).gitProjectId).toBeNull(); // sample task

    const reqStart = await agent
      .post(`/api/tasks/${taskId}/request-start`)
      .send({ workerId: 'wkr_codex' })
      .expect(200);
    await agent
      .post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);
    expect(store.task(taskId)!.status).toBe('running');

    // the SimulatedAdapter supports pause — a real CLI path would refuse (409)
    await agent.post(`/api/tasks/${taskId}/pause`).send({}).expect(200);
    await agent.post(`/api/tasks/${taskId}/resume`).send({}).expect(200);

    await waitFor(() => store.task(taskId)!.status === 'review', 'simulated run reaches review', 20000);

    // the fake CLI would have created a real workspace + greet.py — its total
    // absence proves no real CLI process ever ran for this sample task
    expect(fs.existsSync(path.join(dataDir, 'workspaces'))).toBe(false);
    const task = store.task(taskId)!;
    expect(task.evidence).toBeTruthy();
    expect(task.evidence!.summary).not.toContain('greet.py');
  });

  it('a worker with an unknown/real adapter id still routes to the simulated adapter', async () => {
    const { ctx, agent } = testContext();
    const store = ctx.store;
    const worker = store.worker('wkr_antigravity')!;
    worker.adapter = 'antigravity';
    worker.integration = 'real';
    store.upsertWorker(worker);

    const created = await agent
      .post('/api/tasks')
      .send({ title: 'Sample UI tweak', goal: 'Polish the dashboard header', projectId: 'proj_homelab', risk: 'low' })
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
    await waitFor(() => store.task(taskId)!.status === 'review', 'simulated antigravity run', 25000);
    expect(store.task(taskId)!.evidence).toBeTruthy();
  }, 30000);

  it('antigravity permission bypass is OPT-IN (default false)', () => {
    const prev = process.env.ANTIGRAVITY_SKIP_PERMISSIONS;
    try {
      delete process.env.ANTIGRAVITY_SKIP_PERMISSIONS;
      expect(loadConfig().antigravitySkipPermissions).toBe(false);
      process.env.ANTIGRAVITY_SKIP_PERMISSIONS = '0';
      expect(loadConfig().antigravitySkipPermissions).toBe(false);
      process.env.ANTIGRAVITY_SKIP_PERMISSIONS = '1';
      expect(loadConfig().antigravitySkipPermissions).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ANTIGRAVITY_SKIP_PERMISSIONS;
      else process.env.ANTIGRAVITY_SKIP_PERMISSIONS = prev;
    }
  });
});
