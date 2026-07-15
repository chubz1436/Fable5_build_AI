import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/store';
import { seedIfEmpty } from '../src/store/seed';
import { testContext } from './helpers';

describe('persistence', () => {
  it('seeds a fresh data file with projects, workers and history', () => {
    const { ctx } = testContext();
    expect(ctx.store.projects.length).toBeGreaterThanOrEqual(3);
    expect(ctx.store.workers.length).toBe(4);
    expect(ctx.store.tasks.some((t) => t.status === 'completed' && t.evidence)).toBe(true);
  });

  it('does not reseed a non-empty store', () => {
    const { ctx } = testContext();
    const before = ctx.store.tasks.length;
    seedIfEmpty(ctx.store);
    expect(ctx.store.tasks.length).toBe(before);
  });

  it('round-trips all entities across a restart', () => {
    const { ctx, dataFile } = testContext();
    const task = ctx.store.tasks[0]!;
    ctx.store.addEvent({ type: 'test.marker', message: 'marker event', taskId: task.id });
    ctx.store.flushSync();

    const reloaded = new Store(dataFile);
    expect(reloaded.tasks.length).toBe(ctx.store.tasks.length);
    expect(reloaded.workers.length).toBe(ctx.store.workers.length);
    expect(reloaded.projects.length).toBe(ctx.store.projects.length);
    expect(reloaded.recentEvents(10).some((e) => e.type === 'test.marker')).toBe(true);
    const roundTripped = reloaded.task(task.id)!;
    expect(roundTripped.title).toBe(task.title);
    expect(roundTripped.acceptanceCriteria).toEqual(task.acceptanceCriteria);
  });

  it('writes atomically (no partial tmp file left behind)', () => {
    const { ctx, dataFile } = testContext();
    ctx.store.flushSync();
    expect(fs.existsSync(dataFile)).toBe(true);
    expect(fs.existsSync(`${dataFile}.tmp`)).toBe(false);
    // valid JSON on disk
    expect(() => JSON.parse(fs.readFileSync(dataFile, 'utf8'))).not.toThrow();
  });

  it('recovers interrupted runs on boot', async () => {
    const { ctx, dataFile } = testContext();
    // fake a crash mid-run: task running, worker busy, then reload with recovery
    const task = ctx.store.tasks.find((t) => t.status === 'ready')!;
    task.status = 'awaiting_approval';
    ctx.store.upsertTask(task);
    task.status = 'running';
    task.assignedWorkerId = 'wkr_codex';
    ctx.store.upsertTask(task);
    const worker = ctx.store.worker('wkr_codex')!;
    worker.availability = 'busy';
    worker.currentTaskId = task.id;
    ctx.store.upsertWorker(worker);
    ctx.store.flushSync();

    const { createContext } = await import('../src/app');
    const rebooted = createContext({ dataFile, recoverOnBoot: true, simSpeed: 500 });
    const recovered = rebooted.store.task(task.id)!;
    expect(recovered.status).toBe('blocked');
    expect(recovered.blockReason).toContain('restart');
    expect(rebooted.store.worker('wkr_codex')!.availability).toBe('idle');
  });
});
