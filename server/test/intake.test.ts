import { describe, expect, it } from 'vitest';
import { IntakeError, parseGoal } from '../src/domain/intake';
import { testContext } from './helpers';

const { ctx } = testContext();
const projects = ctx.store.projects;
const workers = ctx.store.workers;

describe('intake parser', () => {
  it('detects high risk from dangerous keywords', () => {
    const d = parseGoal(
      'Migrate the recipe database schema to support tags',
      projects,
      workers,
    );
    expect(d.risk).toBe('high');
    expect(d.riskRationale).toContain('migrate');
  });

  it('defaults to low risk for additive UI work', () => {
    const d = parseGoal('Add a temperature graph to the overview page', projects, workers);
    expect(d.risk).toBe('low');
  });

  it('detects priority keywords', () => {
    expect(parseGoal('Urgent: fix the crash on load', projects, workers).priority).toBe('p0');
    expect(parseGoal('Someday add dark mode', projects, workers).priority).toBe('p3');
    expect(parseGoal('Add a settings page', projects, workers).priority).toBe('p2');
  });

  it('derives tags from the goal text', () => {
    const d = parseGoal('Fix the broken chart component on the status page', projects, workers);
    expect(d.tags).toContain('bugfix');
    expect(d.tags).toContain('frontend');
  });

  it('matches the project by name mention', () => {
    const d = parseGoal('Continue the next batch for the Games Project', projects, workers);
    expect(d.projectId).toBe('proj_games');
  });

  it('respects an explicit project override', () => {
    const d = parseGoal('Continue the Games Project work', projects, workers, 'proj_recipes');
    expect(d.projectId).toBe('proj_recipes');
  });

  it('produces a bounded title and acceptance criteria', () => {
    const longGoal =
      'Refactor the extremely long and winding data ingestion pipeline that currently spans seventeen modules and really should be consolidated into a coherent set of composable stages. Do it carefully.';
    const d = parseGoal(longGoal, projects, workers);
    expect(d.title.length).toBeLessThanOrEqual(72);
    expect(d.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(d.acceptanceCriteria[0]).toBe('All existing tests pass');
  });

  it('always includes a worker recommendation with reasons', () => {
    const d = parseGoal('Write docs for the sensor API', projects, workers);
    expect(d.recommendation.workerId).toBeTruthy();
    expect(d.recommendation.reasons.length).toBeGreaterThan(0);
    expect(d.recommendation.scores.length).toBe(workers.length);
  });

  it('rejects empty input', () => {
    expect(() => parseGoal('   ', projects, workers)).toThrow(IntakeError);
  });
});
