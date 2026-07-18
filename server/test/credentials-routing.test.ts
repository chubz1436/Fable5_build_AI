import { describe, expect, it } from 'vitest';
import type { Approval, Project, Task, TaskDraft } from '../../shared/types';
import { allowlistedChildEnv, codexEnvExtra } from '../src/attempts/env';
import { loadConfig } from '../src/config';
import { CodexRunner } from '../src/attempts/runners';
import { makeTempGitRepo, testContext } from './helpers';

const PARENT = {
  PATH: 'C:\\bin',
  CODEX_HOME: 'C:\\Users\\me\\.codex',
  OPENAI_API_KEY: 'sk-owner-key',
  OPENAI_BASE_URL: 'https://api.example.test/v1',
  OPENAI_PROJECT: 'proj_123',
  AUTH_TOKEN: 'command-center-secret',
  SOME_OTHER_SECRET: 'nope',
};

describe('Codex credential modes', () => {
  it('DEFAULT is login-file auth: no API-key variables are passed to the worker', () => {
    const env = allowlistedChildEnv(codexEnvExtra('login_file'), PARENT);
    expect(env.CODEX_HOME).toBe('C:\\Users\\me\\.codex'); // login file location
    expect(env.PATH).toBe('C:\\bin');
    for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_PROJECT', 'AUTH_TOKEN', 'SOME_OTHER_SECRET']) {
      expect(env[k], k).toBeUndefined();
    }
  });

  it('opt-in api_key mode forwards the API-key variables (and still no unrelated secrets)', () => {
    const env = allowlistedChildEnv(codexEnvExtra('api_key'), PARENT);
    expect(env.CODEX_HOME).toBe('C:\\Users\\me\\.codex');
    expect(env.OPENAI_API_KEY).toBe('sk-owner-key');
    expect(env.OPENAI_BASE_URL).toBe('https://api.example.test/v1');
    expect(env.OPENAI_PROJECT).toBe('proj_123');
    // opting into API-key auth never widens the allowlist to other secrets
    expect(env.AUTH_TOKEN).toBeUndefined();
    expect(env.SOME_OTHER_SECRET).toBeUndefined();
  });

  it('config defaults to login_file and only opts in on the exact value', () => {
    const prev = process.env.CODEX_AUTH_MODE;
    try {
      delete process.env.CODEX_AUTH_MODE;
      expect(loadConfig().codexAuthMode).toBe('login_file');
      process.env.CODEX_AUTH_MODE = 'env';
      expect(loadConfig().codexAuthMode).toBe('login_file'); // anything else = default
      process.env.CODEX_AUTH_MODE = 'api_key';
      expect(loadConfig().codexAuthMode).toBe('api_key');
    } finally {
      if (prev === undefined) delete process.env.CODEX_AUTH_MODE;
      else process.env.CODEX_AUTH_MODE = prev;
    }
  });

  it('the runner reports its credential mode; default is login_file', () => {
    expect(new CodexRunner({ command: 'codex', model: '' }).authMode).toBe('login_file');
    expect(new CodexRunner({ command: 'codex', model: '', authMode: 'api_key' }).authMode).toBe('api_key');
  });

  it('the credential mode is part of the approved ExecutionSpec', async () => {
    for (const mode of ['login_file', 'api_key'] as const) {
      const { agent } = testContext({ codexAuthMode: mode });
      const repo = makeTempGitRepo({ 'README.md': '# r\n' });
      const project = (await agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo }).expect(201))
        .body as Project;
      const task = (
        await agent.post('/api/tasks').send({ title: 'notes', goal: 'Write notes', projectId: project.id }).expect(201)
      ).body as Task;
      const approval = (
        (await agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as {
          approval: Approval;
        }
      ).approval;
      // the deterministic test runner reports 'none'; the codex adapter reports
      // the configured mode — either way the spec records it explicitly
      expect(approval.executionSpec!.credentialMode).toBeTruthy();
    }
  });

  it('switching the credential mode after a grant invalidates it', async () => {
    const { ctx, agent } = testContext({ attemptRunner: 'codex', codexAuthMode: 'login_file' });
    const repo = makeTempGitRepo({ 'README.md': '# r\n' });
    const codex = ctx.store.worker('wkr_codex')!;
    codex.adapter = 'codex';
    ctx.store.upsertWorker(codex);
    const project = (await agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo }).expect(201))
      .body as Project;
    const task = (
      await agent.post('/api/tasks').send({ title: 'notes', goal: 'Write notes', projectId: project.id }).expect(201)
    ).body as Task;
    const approval = (
      (await agent.post(`/api/tasks/${task.id}/request-start`).send({ workerId: 'wkr_codex' }).expect(200)).body as {
        approval: Approval;
      }
    ).approval;
    expect(approval.executionSpec!.credentialMode).toBe('login_file');

    // the owner flips to API-key auth after the grant was issued
    ctx.config.codexAuthMode = 'api_key';
    const res = await agent.post(`/api/approvals/${approval.id}/decision`).send({ decision: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('changed');
  });
});

describe('repository routing: intake and API', () => {
  it('intake recommends ONLY an AttemptService-supported worker for a git project', async () => {
    const { ctx, agent } = testContext({ attemptRunner: 'codex' });
    const repo = makeTempGitRepo({ 'README.md': '# r\n' });
    // only the Codex worker is repo-capable in codex mode
    const codex = ctx.store.worker('wkr_codex')!;
    codex.adapter = 'codex';
    ctx.store.upsertWorker(codex);
    const project = (await agent.post('/api/projects/register').send({ name: 'R', repoRoot: repo }).expect(201))
      .body as Project;

    // a docs-flavoured goal would normally route to a docs-strong worker
    const draft = (
      await agent
        .post('/api/tasks/parse')
        .send({ text: 'Write documentation for the export format', projectId: project.id })
        .expect(200)
    ).body as TaskDraft;

    expect(draft.recommendation.workerId).toBe('wkr_codex');
    // the ranked list must not offer workers that request-start would refuse
    const capable = ctx.store.workers.filter((w) => ctx.attempts.supportsRepositoryAttempts(w)).map((w) => w.id);
    for (const s of draft.recommendation.scores) expect(capable).toContain(s.workerId);
  });

  it('sample projects still rank every worker', async () => {
    const { agent } = testContext({ attemptRunner: 'codex' });
    const draft = (
      await agent
        .post('/api/tasks/parse')
        .send({ text: 'Write documentation for the export format', projectId: 'proj_recipes' })
        .expect(200)
    ).body as TaskDraft;
    expect(draft.recommendation.scores.length).toBeGreaterThan(1);
  });

  it('/api/state advertises the repo-capable worker set for the UI', async () => {
    const { ctx, agent } = testContext({ attemptRunner: 'codex' });
    const codex = ctx.store.worker('wkr_codex')!;
    codex.adapter = 'codex';
    ctx.store.upsertWorker(codex);
    const state = (await agent.get('/api/state').expect(200)).body as {
      system: { repoCapableWorkerIds: string[] };
    };
    expect(state.system.repoCapableWorkerIds).toEqual(['wkr_codex']);
  });
});
