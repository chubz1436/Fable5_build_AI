import { describe, expect, it } from 'vitest';
import { recommendWorker } from '../src/domain/recommend';
import { testContext } from './helpers';

const { ctx } = testContext();
const workers = ctx.store.workers;

describe('routing engine', () => {
  it('prefers strength matches', () => {
    const rec = recommendWorker({ tags: ['frontend', 'feature'], risk: 'low', priority: 'p2' }, workers);
    // Antigravity and Codex both match; either is acceptable, but the winner
    // must actually have the strengths.
    const winner = workers.find((w) => w.id === rec.workerId)!;
    expect(winner.strengths).toContain('frontend');
    expect(rec.reasons.join(' ')).toContain('frontend');
  });

  it('routes high-risk work to careful workers', () => {
    const rec = recommendWorker({ tags: ['backend'], risk: 'high', priority: 'p1' }, workers);
    const winner = workers.find((w) => w.id === rec.workerId)!;
    expect(winner.traits).toContain('careful');
  });

  it('excludes offline workers', () => {
    const roster = structuredClone(workers);
    const best = roster.find((w) => w.id === 'wkr_claude_code')!;
    best.health = 'offline';
    const rec = recommendWorker({ tags: ['refactor', 'tests'], risk: 'medium', priority: 'p2' }, roster);
    expect(rec.workerId).not.toBe('wkr_claude_code');
  });

  it('penalizes busy workers', () => {
    const roster = structuredClone(workers);
    const anti = roster.find((w) => w.id === 'wkr_antigravity')!;
    anti.availability = 'busy';
    const rec = recommendWorker({ tags: ['frontend'], risk: 'low', priority: 'p2' }, roster);
    expect(rec.workerId).not.toBe('wkr_antigravity');
  });

  it('explains every score with factors', () => {
    const rec = recommendWorker({ tags: ['docs'], risk: 'low', priority: 'p3' }, workers);
    for (const s of rec.scores) {
      expect(s.factors.length).toBeGreaterThan(0);
    }
    // ranked descending
    const values = rec.scores.map((s) => s.score);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });
});
