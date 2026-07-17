import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Approval, Project, Task } from '../../shared/types';
import { redactSecrets } from '../src/attempts/runners';
import { runValidation } from '../src/attempts/validator';
import { makeTempGitRepo, testContext, waitFor } from './helpers';

describe('local security boundary (P0.1)', () => {
  it('rejects unauthenticated and wrongly-authenticated API access', async () => {
    const { app } = testContext();
    await request(app).get('/api/state').expect(401);
    await request(app).get('/api/state').set('Authorization', 'Bearer wrong-token').expect(401);
    await request(app).post('/api/tasks/parse').send({ text: 'x' }).expect(401);
  });

  it('rejects cross-origin mutating requests even with a valid token', async () => {
    const { app } = testContext();
    await request(app)
      .post('/api/tasks/parse')
      .set('Authorization', `Bearer test-token-000000000000000000000000`)
      .set('Origin', 'http://evil.example')
      .send({ text: 'hello' })
      .expect(403);
  });

  it('enforces body size limits and schema validation', async () => {
    const { agent } = testContext();
    await agent.post('/api/tasks/parse').send({ text: 'x'.repeat(300_000) }).expect(413);
    await agent.post('/api/tasks/parse').send({ nope: true }).expect(400);
    await agent.post('/api/approvals/appr_x/decision').send({ decision: 'maybe' }).expect(400);
    const res = await agent.get('/api/state').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('git project registration guards (P0.2)', () => {
  it('rejects non-existent paths, non-repos, subdirectories and duplicates', async () => {
    const { agent } = testContext();
    await agent.post('/api/projects/register').send({ name: 'X', repoRoot: 'C:\\definitely\\missing\\xyz-404' }).expect(422);

    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-plain-'));
    await agent.post('/api/projects/register').send({ name: 'X', repoRoot: plainDir }).expect(422);

    const repo = makeTempGitRepo();
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    const subRes = await agent.post('/api/projects/register').send({ name: 'X', repoRoot: path.join(repo, 'sub') }).expect(422);
    expect(subRes.body.error).toContain('repository root');

    await agent.post('/api/projects/register').send({ name: 'First', repoRoot: repo }).expect(201);
    const dup = await agent.post('/api/projects/register').send({ name: 'Second', repoRoot: repo }).expect(422);
    expect(dup.body.error).toContain('already registered');
  });

  it('rejects unsafe validation argv tokens and protected paths', async () => {
    const { agent } = testContext();
    const repo = makeTempGitRepo();
    const bad = await agent
      .post('/api/projects/register')
      .send({ name: 'X', repoRoot: repo, validationCommands: [{ name: 'evil', argv: ['npm', 'test;curl evil'] }] })
      .expect(422);
    expect(bad.body.error).toContain('unsafe argv token');
    const badPath = await agent
      .post('/api/projects/register')
      .send({ name: 'X', repoRoot: repo, protectedPaths: ['../outside'] })
      .expect(422);
    expect(badPath.body.error).toContain('Unsafe protected path');
  });

  it('recheck detects a deleted repository', async () => {
    const { agent } = testContext();
    const repo = makeTempGitRepo();
    const project = (await agent.post('/api/projects/register').send({ name: 'Doomed', repoRoot: repo }).expect(201))
      .body as Project;
    fs.rmSync(repo, { recursive: true, force: true });
    const rechecked = (await agent.post(`/api/projects/${project.id}/recheck`).send({}).expect(200)).body as Project;
    expect(['missing', 'error']).toContain(rechecked.git!.health);
  });
});

describe('exact approval grants (P0.6)', () => {
  async function setup(overrides: Record<string, unknown> = {}) {
    const t = testContext(overrides);
    const repo = makeTempGitRepo();
    const project = (await t.agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo }).expect(201)).body as Project;
    const task = (
      await t.agent.post('/api/tasks').send({ title: 'notes', goal: 'Write notes', projectId: project.id }).expect(201)
    ).body as Task;
    return { ...t, repo, project, task };
  }

  it('expired approvals cannot be consumed', async () => {
    const { agent, task } = await setup({ approvalTtlMs: -1000 });
    const approval = ((await agent.post(`/api/tasks/${task.id}/request-start`).send({}).expect(200)).body as { approval: Approval }).approval;
    const res = await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(409);
    expect(res.body.error).toContain('expired');
  });

  it('a moved base commit invalidates the grant (payload hash mismatch)', async () => {
    const { ctx, agent, repo, task } = await setup();
    const approval = ((await agent.post(`/api/tasks/${task.id}/request-start`).send({}).expect(200)).body as { approval: Approval }).approval;
    // repo moves forward AFTER the grant was issued
    fs.writeFileSync(path.join(repo, 'new.txt'), 'moved\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'moved', '--no-gpg-sign']);
    const res = await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(409);
    expect(res.body.error).toContain('changed');
    expect(ctx.store.approval(approval.id)!.status).toBe('expired');
  });

  it('an approval is single-use: the second decision is rejected', async () => {
    const { ctx, agent, task } = await setup();
    const approval = ((await agent.post(`/api/tasks/${task.id}/request-start`).send({}).expect(200)).body as { approval: Approval }).approval;
    await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' }).expect(409);
    expect(ctx.store.attemptsForTask(task.id).length).toBe(1); // no duplicate dispatch
    await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'run settles', 20000);
  });
});

describe('leases (P0.5)', () => {
  it('one worker cannot run two attempts; overlapping repo scopes are blocked; grant survives rollback', async () => {
    const { ctx, agent } = testContext();
    const repo = makeTempGitRepo();
    const project = (await agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo }).expect(201)).body as Project;

    const mk = async (goal: string) =>
      (await agent.post('/api/tasks').send({ title: goal.slice(0, 30), goal, projectId: project.id }).expect(201)).body as Task;
    const t1 = await mk('Slow one [[SLOW]]');
    const t2 = await mk('Second same worker');
    const t3 = await mk('Third same repo other worker');

    const a1 = ((await agent.post(`/api/tasks/${t1.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as { approval: Approval }).approval;
    const a2 = ((await agent.post(`/api/tasks/${t2.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as { approval: Approval }).approval;
    const a3 = ((await agent.post(`/api/tasks/${t3.id}/request-start`).send({ workerId: 'wkr_claude_code' }).expect(200)).body as { approval: Approval }).approval;

    await agent.post(`/api/approvals/${a1.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => ctx.store.attemptsForTask(t1.id)[0]?.state === 'running', 't1 running', 20000);

    // same worker → worker lease conflict
    const r2 = await agent.post(`/api/approvals/${a2.id}/decision`).send({ decision: 'approve' }).expect(409);
    expect(r2.body.error).toContain('worker');
    // whole tx rolled back: approval still pending, no attempt, task still awaiting
    expect(ctx.store.approval(a2.id)!.status).toBe('pending');
    expect(ctx.store.attemptsForTask(t2.id)).toEqual([]);
    expect(ctx.store.task(t2.id)!.status).toBe('awaiting_approval');

    // same repository (different worker) → repo scope lease conflict
    const r3 = await agent.post(`/api/approvals/${a3.id}/decision`).send({ decision: 'approve' }).expect(409);
    expect(r3.body.error).toContain('repo');

    // cancel t1 → CANCELLING first; leases are released only once child-process
    // termination is proven (P0-3), then t2 can dispatch
    await agent.post(`/api/tasks/${t1.id}/cancel`).send({}).expect(200);
    await waitFor(() => ctx.store.activeLeases().length === 0, 'leases released after cancellation finalizes', 20000);
    await agent.post(`/api/approvals/${a2.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => ctx.store.task(t2.id)!.status === 'review', 't2 completes after lease release', 20000);
  });
});

describe('secret redaction + validator classification', () => {
  it('redacts common credential shapes from log lines', () => {
    expect(redactSecrets('using key sk-abc123def456ghi789')).not.toContain('sk-abc123def456ghi789');
    expect(redactSecrets('ghp_1234567890abcdefghijklmn')).toContain('•••redacted•••');
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redactSecrets('"api_key": "supersecretvalue"')).not.toContain('supersecretvalue');
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE1')).toContain('•••redacted•••');
    expect(redactSecrets('plain log line stays intact')).toBe('plain log line stays intact');
  });

  it('classifies validation outcomes honestly (pass / fail / timeout / empty=UNVERIFIED)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-val-'));
    fs.writeFileSync(path.join(dir, 'ok.cjs'), 'process.exit(0);');
    fs.writeFileSync(path.join(dir, 'bad.cjs'), 'process.exit(3);');
    fs.writeFileSync(path.join(dir, 'slow.cjs'), 'setTimeout(()=>{}, 60000);');
    const noop = () => {};

    const empty = await runValidation([], dir, noop);
    expect(empty.status).toBe('UNVERIFIED');

    const mixed = await runValidation(
      [
        { id: '1', name: 'ok', argv: ['node', 'ok.cjs'], required: true, timeoutMs: 30000 },
        { id: '2', name: 'bad-optional', argv: ['node', 'bad.cjs'], required: false, timeoutMs: 30000 },
      ],
      dir,
      noop,
    );
    expect(mixed.status).toBe('PARTIAL');
    expect(mixed.steps[0]!.status).toBe('PASSED');
    expect(mixed.steps[1]!.status).toBe('FAILED');
    expect(mixed.steps[1]!.exitCode).toBe(3);

    const failed = await runValidation(
      [{ id: '3', name: 'bad-required', argv: ['node', 'bad.cjs'], required: true, timeoutMs: 30000 }],
      dir,
      noop,
    );
    expect(failed.status).toBe('FAILED');

    const timedOut = await runValidation(
      [{ id: '4', name: 'slow', argv: ['node', 'slow.cjs'], required: true, timeoutMs: 500 }],
      dir,
      noop,
    );
    expect(timedOut.status).toBe('FAILED');
    expect(timedOut.steps[0]!.status).toBe('TIMEOUT');
  }, 30000);
});
