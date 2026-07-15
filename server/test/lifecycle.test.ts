import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, LifecycleError } from '../src/domain/lifecycle';

describe('task lifecycle state machine', () => {
  it('allows the happy path', () => {
    expect(canTransition('backlog', 'ready')).toBe(true);
    expect(canTransition('ready', 'awaiting_approval')).toBe(true);
    expect(canTransition('awaiting_approval', 'running')).toBe(true);
    expect(canTransition('running', 'verifying')).toBe(true);
    expect(canTransition('verifying', 'review')).toBe(true);
    expect(canTransition('review', 'completed')).toBe(true);
  });

  it('allows recovery paths', () => {
    expect(canTransition('running', 'blocked')).toBe(true);
    expect(canTransition('blocked', 'running')).toBe(true);
    expect(canTransition('running', 'paused')).toBe(true);
    expect(canTransition('paused', 'running')).toBe(true);
    expect(canTransition('review', 'blocked')).toBe(true); // changes requested
  });

  it('blocks illegal jumps', () => {
    expect(canTransition('backlog', 'running')).toBe(false);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('cancelled', 'ready')).toBe(false);
    expect(canTransition('ready', 'review')).toBe(false);
    expect(() => assertTransition('backlog', 'completed')).toThrow(LifecycleError);
  });

  it('makes terminal states terminal', () => {
    for (const terminal of ['completed', 'cancelled', 'failed'] as const) {
      for (const target of ['ready', 'running', 'blocked', 'review'] as const) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });
});
