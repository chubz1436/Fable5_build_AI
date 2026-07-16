import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db, importLegacyJson } from '../src/db/db';
import { Store } from '../src/store/store';
import { seedIfEmpty } from '../src/store/seed';
import { testContext } from './helpers';

describe('sqlite persistence', () => {
  it('seeds a fresh database with projects, workers and history', () => {
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

  it('round-trips all entities across a restart (new Db handle, same file)', () => {
    const { ctx, dbFile } = testContext();
    const task = ctx.store.tasks[0]!;
    ctx.store.addEvent({ type: 'test.marker', message: 'marker event', taskId: task.id });

    const reloaded = new Store(new Db(dbFile));
    expect(reloaded.tasks.length).toBe(ctx.store.tasks.length);
    expect(reloaded.workers.length).toBe(ctx.store.workers.length);
    expect(reloaded.projects.length).toBe(ctx.store.projects.length);
    expect(reloaded.recentEvents(10).some((e) => e.type === 'test.marker')).toBe(true);
    const roundTripped = reloaded.task(task.id)!;
    expect(roundTripped.title).toBe(task.title);
    expect(roundTripped.acceptanceCriteria).toEqual(task.acceptanceCriteria);
    reloaded.close();
  });

  it('uses WAL mode with foreign keys on', () => {
    const { ctx } = testContext();
    const mode = ctx.db.sqlite.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    const fk = ctx.db.sqlite.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  it('imports the legacy JSON store once and never modifies the file', () => {
    const { dataDir } = testContext();
    // build a fake legacy store next to a brand-new db
    const legacy = path.join(dataDir, 'legacy.json');
    const legacyDoc = {
      schemaVersion: 1,
      projects: [{ id: 'proj_x', name: 'Legacy X', description: '', color: '#fff', tags: [], createdAt: new Date().toISOString() }],
      workers: [],
      tasks: [],
      approvals: [],
      handoffs: [],
      events: [{ id: 'evt_x', at: new Date().toISOString(), type: 'legacy.marker', level: 'info', message: 'hello' }],
    };
    fs.writeFileSync(legacy, JSON.stringify(legacyDoc), 'utf8');
    const before = fs.readFileSync(legacy, 'utf8');

    const db2 = new Db(path.join(dataDir, 'second.db'));
    expect(importLegacyJson(db2, legacy)).toBe(true);
    const store2 = new Store(db2);
    expect(store2.project('proj_x')?.name).toBe('Legacy X');
    expect(store2.project('proj_x')?.kind).toBe('sample');
    expect(store2.recentEvents(10).some((e) => e.type === 'legacy.marker')).toBe(true);
    // idempotent: second call is a no-op
    expect(importLegacyJson(db2, legacy)).toBe(false);
    // source file untouched
    expect(fs.readFileSync(legacy, 'utf8')).toBe(before);
    store2.close();
  });

  it('recovers interrupted simulated runs on boot', async () => {
    const { ctx, dbFile, dataDir } = testContext();
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
    ctx.store.close();

    const { createContext } = await import('../src/app');
    const rebooted = createContext({
      dataDir,
      dbFile,
      authToken: 'x',
      recoverOnBoot: true,
      simSpeed: 500,
      realAdapters: false,
    });
    const recovered = rebooted.store.task(task.id)!;
    expect(recovered.status).toBe('blocked');
    expect(recovered.blockReason).toContain('restart');
    expect(rebooted.store.worker('wkr_codex')!.availability).toBe('idle');
  });
});
