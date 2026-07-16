import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Approval, Task, TaskDraft } from '../../shared/types';
import {
  diffSnapshots,
  extractFinalReport,
  snapshotWorkspace,
  summarizeToolUse,
} from '../src/engine/adapters/claude-code';
import { testContext, waitFor } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = `"${process.execPath}" "${path.join(here, 'fixtures', 'fake-claude.mjs')}"`;

describe('claude-code adapter helpers', () => {
  it('extracts the last json report block', () => {
    const text =
      'thinking…\n```json\n{"summary":"old"}\n```\nmore\n```json\n{"summary":"final","confidence":0.8}\n```';
    expect(extractFinalReport(text)).toEqual({ summary: 'final', confidence: 0.8 });
  });

  it('returns null for missing or invalid blocks', () => {
    expect(extractFinalReport('no block here')).toBeNull();
    expect(extractFinalReport('```json\n{not valid\n```')).toBeNull();
  });

  it('summarizes tool use with its target', () => {
    expect(summarizeToolUse('Write', { file_path: 'a.ts' })).toBe('Write a.ts');
    expect(summarizeToolUse('Glob', { pattern: '**/*.md' })).toBe('Glob **/*.md');
    expect(summarizeToolUse('Read', {})).toBe('Read');
  });

  it('diffs workspace snapshots with real line counts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-ws-'));
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nb\n');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'x\n');
    fs.writeFileSync(path.join(dir, '_TASK_BRIEF.md'), 'brief — excluded\n');
    const before = snapshotWorkspace(dir);

    fs.rmSync(path.join(dir, 'gone.txt'));
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nb\nc\nd\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), '1\n2\n3\n');
    const after = snapshotWorkspace(dir);

    const changes = diffSnapshots(before, after);
    expect(changes.map((c) => `${c.changeType}:${c.path}`)).toEqual([
      'deleted:gone.txt',
      'modified:keep.txt',
      'added:new.txt',
    ]);
    const added = changes.find((c) => c.path === 'new.txt')!;
    expect(added.additions).toBe(4); // 3 lines + trailing newline split
    const modified = changes.find((c) => c.path === 'keep.txt')!;
    expect(modified.additions).toBe(2);
    expect(modified.deletions).toBe(0);
    // the brief never appears in evidence
    expect(changes.some((c) => c.path.includes('_TASK_BRIEF'))).toBe(false);
  });
});

describe('claude-code adapter end-to-end (fake CLI)', () => {
  it('runs a real-adapter task: spawn → stream logs → workspace evidence → owner review', async () => {
    const { ctx, app, dataFile } = testContext({ claudeCommand: FAKE_CLI });
    const store = ctx.store;

    // promote the Claude Code worker to the real adapter (what boot detection does)
    const worker = store.worker('wkr_claude_code')!;
    worker.adapter = 'claude-code';
    worker.integration = 'real';
    store.upsertWorker(worker);

    const parse = await request(app)
      .post('/api/tasks/parse')
      .send({ text: 'Write a hello file for the Recipe Box docs' })
      .expect(200);
    const created = await request(app)
      .post('/api/tasks')
      .send(parse.body as TaskDraft)
      .expect(201);
    const taskId = (created.body as Task).id;

    const reqStart = await request(app)
      .post(`/api/tasks/${taskId}/request-start`)
      .send({ workerId: 'wkr_claude_code' })
      .expect(200);
    await request(app)
      .post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);
    expect(store.task(taskId)!.status).toBe('running');

    // real CLI processes cannot be paused — the engine must refuse honestly
    const pauseRes = await request(app).post(`/api/tasks/${taskId}/pause`).send({});
    expect(pauseRes.status).toBe(409);
    expect(pauseRes.body.error).toContain('cannot be paused');

    await waitFor(() => store.task(taskId)!.status === 'review', 'review after fake CLI run', 15000);
    const task = store.task(taskId)!;

    // evidence comes from a real workspace diff, not from model claims
    expect(task.evidence).toBeTruthy();
    const hello = task.evidence!.filesChanged.find((f) => f.path === 'hello.txt');
    expect(hello?.changeType).toBe('added');
    expect(hello!.additions).toBeGreaterThan(0);
    expect(task.evidence!.summary).toBe('Created hello.txt');
    expect(task.evidence!.workPerformed).toEqual(['Wrote hello.txt']);

    // the file genuinely exists on disk in the isolated workspace
    const workspaceFile = path.join(path.dirname(dataFile), 'workspaces', taskId, 'hello.txt');
    expect(fs.existsSync(workspaceFile)).toBe(true);
    expect(fs.readFileSync(workspaceFile, 'utf8')).toContain('hello from fake claude');

    // no automated verification ran → criteria stay unjudged for the owner
    expect(task.acceptanceCriteria.every((c) => c.met === null)).toBe(true);

    // live log console captured the streamed session
    const logs = store.eventsForTask(taskId).filter((e) => e.type === 'run.log');
    expect(logs.some((e) => e.message.includes('session started'))).toBe(true);
    expect(logs.some((e) => e.message.includes('⚒ Write hello.txt'))).toBe(true);

    // owner accepts the delivery
    const completion = store
      .approvalsForTask(taskId)
      .find((a) => a.type === 'completion' && a.status === 'pending')!;
    expect(completion.recommendationReason).toContain('no automated verification');
    await request(app)
      .post(`/api/approvals/${completion.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);
    expect(store.task(taskId)!.status).toBe('completed');
  });

  it('blocks with a clear reason when the CLI cannot launch', async () => {
    const { ctx, app } = testContext({
      claudeCommand: '"definitely-not-a-real-command-xyz"',
      claudeTimeoutMs: 5000,
    });
    const store = ctx.store;
    const worker = store.worker('wkr_claude_code')!;
    worker.adapter = 'claude-code';
    store.upsertWorker(worker);

    const parse = await request(app)
      .post('/api/tasks/parse')
      .send({ text: 'Write a tiny note file' })
      .expect(200);
    const created = await request(app).post('/api/tasks').send(parse.body).expect(201);
    const taskId = (created.body as Task).id;
    const reqStart = await request(app)
      .post(`/api/tasks/${taskId}/request-start`)
      .send({ workerId: 'wkr_claude_code' })
      .expect(200);
    await request(app)
      .post(`/api/approvals/${(reqStart.body as { approval: Approval }).approval.id}/decision`)
      .send({ decision: 'approve' })
      .expect(200);

    await waitFor(() => store.task(taskId)!.status === 'blocked', 'blocked on launch failure', 10000);
    const task = store.task(taskId)!;
    expect(task.blockReason).toMatch(/exited with code|Could not launch/);
    // worker is freed, task is retryable
    expect(store.worker('wkr_claude_code')!.availability).toBe('idle');
  });
});
