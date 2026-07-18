import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Approval, Project, Task } from '../../shared/types';
import { allowlistedChildEnv, CODEX_ENV_EXTRA, minimalValidationEnv } from '../src/attempts/env';
import { makeTempGitRepo, testContext, waitFor } from './helpers';

async function registerRepo(agent: ReturnType<typeof testContext>['agent'], repo: string, extra: Record<string, unknown> = {}): Promise<Project> {
  return (await agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo, ...extra }).expect(201)).body as Project;
}

async function createGitTask(agent: ReturnType<typeof testContext>['agent'], projectId: string, goal: string): Promise<Task> {
  return (await agent.post('/api/tasks').send({ title: goal.slice(0, 40), goal, projectId, risk: 'low' }).expect(201)).body as Task;
}

describe('worker environment allowlist', () => {
  it('allowlistedChildEnv drops arbitrary secrets and keeps only base + extra keys', () => {
    const base = {
      PATH: 'C:\\bin',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\temp',
      CODEX_HOME: 'C:\\Users\\me\\.codex',
      OPENAI_API_KEY: 'sk-real-login-key',
      AUTH_TOKEN: 'command-center-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      MY_COMPANY_DB_PASSWORD: 'hunter2',
      RANDOM_SECRET_XYZ: 'should-not-leak',
    };
    const env = allowlistedChildEnv(CODEX_ENV_EXTRA, base);
    // base benign + Codex login vars preserved
    expect(env.PATH).toBe('C:\\bin');
    expect(env.SYSTEMROOT).toBe('C:\\Windows');
    expect(env.CODEX_HOME).toBe('C:\\Users\\me\\.codex');
    expect(env.OPENAI_API_KEY).toBe('sk-real-login-key'); // normal Codex login preserved
    // Command Center + arbitrary secrets excluded by construction
    for (const k of ['AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MY_COMPANY_DB_PASSWORD', 'RANDOM_SECRET_XYZ']) {
      expect(env[k], k).toBeUndefined();
    }
  });

  it('minimalValidationEnv excludes Codex login vars too (validators need nothing)', () => {
    const env = minimalValidationEnv({ PATH: 'C:\\bin', OPENAI_API_KEY: 'x', CODEX_HOME: 'y' });
    expect(env.PATH).toBe('C:\\bin');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.CI).toBe('1');
  });

  it('a worker never inherits an arbitrary secret variable from the parent process', async () => {
    process.env.CHUBZ_FAKE_SECRET = 'leak-me-if-you-can-1234567890';
    try {
      const { ctx, agent } = testContext();
      const repo = makeTempGitRepo({ 'README.md': '# r\n' });
      const project = await registerRepo(agent, repo);
      // the deterministic runner dumps the requested env var into ENV_DUMP.txt
      const task = await createGitTask(agent, project.id, 'Prove isolation [[DUMPENV:CHUBZ_FAKE_SECRET]]');
      const reqStart = await agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200);
      await agent.post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`).send({ decision: 'approve' }).expect(200);
      await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'review reached', 20000);

      const attempt = ctx.store.attemptsForTask(task.id)[0]!;
      const dump = fs.readFileSync(path.join(attempt.worktreePath!, 'ENV_DUMP.txt'), 'utf8');
      expect(dump).toContain('CHUBZ_FAKE_SECRET=ABSENT');
      expect(dump).not.toContain('leak-me-if-you-can');
    } finally {
      delete process.env.CHUBZ_FAKE_SECRET;
    }
  });
});

describe('operation status hygiene', () => {
  it('a completed attempt leaves NO operation in the running state; consume_approval is succeeded', async () => {
    const { ctx, agent } = testContext();
    const repo = makeTempGitRepo({ 'README.md': '# r\n', 'checks/ok.cjs': 'process.exit(0);' });
    const project = await registerRepo(agent, repo, {
      validationCommands: [{ name: 'ok', argv: ['node', 'checks/ok.cjs'], required: true }],
    });
    const task = await createGitTask(agent, project.id, 'Write notes');
    const reqStart = await agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200);
    await agent.post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`).send({ decision: 'approve' }).expect(200);
    await waitFor(() => ctx.store.task(task.id)!.status === 'review', 'review reached', 20000);

    const attempt = ctx.store.attemptsForTask(task.id)[0]!;
    const ops = ctx.store.operationsForAttempt(attempt.id);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.filter((o) => o.status === 'running')).toEqual([]);
    const consume = ops.find((o) => o.kind === 'consume_approval')!;
    expect(consume.status).toBe('succeeded');
    expect(consume.endedAt).toBeTruthy();

    // and after acceptance, still nothing running
    const completion = ctx.store.approvalsForTask(task.id).find((a) => a.type === 'completion' && a.status === 'pending')!;
    await agent.post(`/api/approvals/${completion.id}/decision`).send({ decision: 'approve' }).expect(200);
    expect(ctx.store.operationsForAttempt(attempt.id).filter((o) => o.status === 'running')).toEqual([]);
  });
});

describe('repository-attempt routing', () => {
  it('exposes which workers may run repository attempts', () => {
    const { ctx } = testContext({ attemptRunner: 'codex' });
    // boot detection upgrades the Codex worker to the real 'codex' adapter
    const codex = ctx.store.worker('wkr_codex')!;
    codex.adapter = 'codex';
    expect(ctx.attempts.supportsRepositoryAttempts(codex)).toBe(true);
    const claude = ctx.store.worker('wkr_claude_code')!;
    claude.adapter = 'claude-code';
    expect(ctx.attempts.supportsRepositoryAttempts(claude)).toBe(false);
    // a still-simulated worker is not eligible for a REAL repository attempt
    expect(ctx.attempts.supportsRepositoryAttempts(ctx.store.worker('wkr_antigravity')!)).toBe(false);
  });

  it('request-start is refused for an adapter AttemptService cannot drive', async () => {
    const { ctx, agent } = testContext({ attemptRunner: 'codex' });
    const repo = makeTempGitRepo({ 'README.md': '# r\n' });
    const project = await registerRepo(agent, repo);
    const task = await createGitTask(agent, project.id, 'Write notes');

    // route Claude Code to its (unsupported) real adapter
    const claude = ctx.store.worker('wkr_claude_code')!;
    claude.adapter = 'claude-code';
    ctx.store.upsertWorker(claude);

    const res = await agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_claude_code' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not available for repository attempts');
    // no approval or attempt was created
    expect(ctx.store.approvalsForTask(task.id)).toEqual([]);
    expect(ctx.store.attemptsForTask(task.id)).toEqual([]);
  });
});
