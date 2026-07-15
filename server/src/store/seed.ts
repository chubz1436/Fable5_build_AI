import type { Project, Task, WorkerProfile } from '../../../shared/types';
import { nowIso, uid } from '../domain/util';
import type { Store } from './store';

/**
 * Seeds a fresh data file with realistic sample projects, the worker roster,
 * and a small amount of history so the Command Center is demonstrable on
 * first launch. Runs only when the store is empty.
 */
export function seedIfEmpty(store: Store): void {
  if (!store.isEmpty) return;

  // -- projects -------------------------------------------------------------
  const games: Project = {
    id: 'proj_games',
    name: 'Games Project',
    description: 'Retro arcade collection built on a shared 2D engine.',
    color: '#8b7bff',
    tags: ['frontend', 'feature'],
    createdAt: nowIso(),
  };
  const homelab: Project = {
    id: 'proj_homelab',
    name: 'Home Lab Dashboard',
    description: 'Status and monitoring panel for the home server rack.',
    color: '#2dd4bf',
    tags: ['backend', 'infra'],
    createdAt: nowIso(),
  };
  const recipes: Project = {
    id: 'proj_recipes',
    name: 'Recipe Box',
    description: 'Personal recipe manager with weekly meal planning.',
    color: '#f5a623',
    tags: ['backend', 'docs'],
    createdAt: nowIso(),
  };
  [games, homelab, recipes].forEach((p) => store.upsertProject(p));

  // -- worker roster ----------------------------------------------------------
  // All workers run on the local simulation engine today. The adapter
  // interface (server/src/engine/adapters/types.ts) is the seam where real
  // CLI/API integrations plug in later.
  const workers: WorkerProfile[] = [
    {
      id: 'wkr_claude_code',
      name: 'Claude Code',
      role: 'Senior implementer',
      provider: 'Anthropic',
      model: 'claude-fable-5',
      avatar: '🎯',
      strengths: ['refactor', 'tests', 'backend', 'bugfix'],
      traits: ['careful', 'thorough'],
      availability: 'idle',
      health: 'online',
      currentTaskId: null,
      adapter: 'simulated',
      integration: 'simulated',
      completedTaskCount: 12,
    },
    {
      id: 'wkr_codex',
      name: 'Codex',
      role: 'Rapid prototyper',
      provider: 'OpenAI',
      model: 'gpt-5-codex',
      avatar: '🤖',
      strengths: ['feature', 'frontend', 'backend'],
      traits: ['fast'],
      availability: 'idle',
      health: 'online',
      currentTaskId: null,
      adapter: 'simulated',
      integration: 'simulated',
      completedTaskCount: 9,
    },
    {
      id: 'wkr_antigravity',
      name: 'Antigravity',
      role: 'UI & product polish',
      provider: 'Google',
      model: 'gemini-3-pro',
      avatar: '🚀',
      strengths: ['frontend', 'feature', 'docs'],
      traits: ['fast', 'visual'],
      availability: 'idle',
      health: 'online',
      currentTaskId: null,
      adapter: 'simulated',
      integration: 'simulated',
      completedTaskCount: 7,
    },
    {
      id: 'wkr_hermes',
      name: 'Hermes',
      role: 'Local & private workhorse',
      provider: 'OpenRouter / local',
      model: 'hermes-4-405b (local)',
      avatar: '🪽',
      strengths: ['docs', 'infra', 'tests'],
      traits: ['local', 'careful'],
      availability: 'idle',
      health: 'degraded',
      currentTaskId: null,
      adapter: 'simulated',
      integration: 'simulated',
      completedTaskCount: 4,
    },
  ];
  workers.forEach((w) => store.upsertWorker(w));

  // -- one completed task with evidence (history demo) -----------------------
  const doneId = uid('task');
  const done: Task = {
    id: doneId,
    title: 'Fix collision detection jitter in Breakout paddle',
    goal: 'Fix the bug where the Breakout paddle jitters when the ball hits its corner. The ball sometimes tunnels through on fast hits.',
    projectId: games.id,
    status: 'completed',
    risk: 'medium',
    priority: 'p1',
    scope: ['engine/physics', 'games/breakout'],
    tags: ['bugfix', 'tests'],
    acceptanceCriteria: [
      { id: uid('ac'), text: 'Ball never tunnels through the paddle at max speed', met: true },
      { id: uid('ac'), text: 'All existing engine tests pass', met: true },
      { id: uid('ac'), text: 'New regression test covers corner hits', met: true },
    ],
    assignedWorkerId: 'wkr_claude_code',
    recommendation: {
      workerId: 'wkr_claude_code',
      reasons: [
        'Strength match: bugfix, tests',
        'Careful trait fits medium-risk physics change',
        'Idle and healthy at time of routing',
      ],
      scores: [
        { workerId: 'wkr_claude_code', score: 9, factors: ['+6 strengths: bugfix, tests', '+2 idle', '+1 careful (risk fit)'] },
        { workerId: 'wkr_codex', score: 4, factors: ['+2 idle', '+2 fast'] },
        { workerId: 'wkr_antigravity', score: 3, factors: ['+2 idle', '+1 healthy'] },
        { workerId: 'wkr_hermes', score: 2, factors: ['+3 strengths: tests', '-2 degraded health'] },
      ],
    },
    attempts: 1,
    progress: 100,
    phase: 'Delivered',
    blockReason: null,
    runPlan: [
      { id: 's1', label: 'Prepare isolated workspace', done: true },
      { id: 's2', label: 'Reproduce corner-hit tunneling in test harness', done: true },
      { id: 's3', label: 'Implement swept-AABB check in engine/physics', done: true },
      { id: 's4', label: 'Add regression test for corner hits', done: true },
      { id: 's5', label: 'Run project test suite', done: true },
      { id: 's6', label: 'Package evidence', done: true },
    ],
    evidence: {
      request: 'Fix the bug where the Breakout paddle jitters when the ball hits its corner.',
      summary:
        'Replaced per-frame overlap test with a swept-AABB collision check so fast balls can no longer tunnel through the paddle. Added a regression test that fires 500 corner hits at max speed.',
      workerId: 'wkr_claude_code',
      workPerformed: [
        'Reproduced tunneling with a deterministic corner-hit harness',
        'Implemented swept-AABB collision in engine/physics/collide.ts',
        'Clamped paddle reflection angle to remove jitter',
        'Added regression test corner-hits.test.ts (500 iterations)',
      ],
      filesChanged: [
        { path: 'engine/physics/collide.ts', changeType: 'modified', summary: 'Swept-AABB check replaces overlap test', additions: 64, deletions: 21 },
        { path: 'games/breakout/paddle.ts', changeType: 'modified', summary: 'Clamp reflection angle at corners', additions: 12, deletions: 4 },
        { path: 'engine/physics/corner-hits.test.ts', changeType: 'added', summary: 'Regression test: 500 max-speed corner hits', additions: 88, deletions: 0 },
      ],
      tests: {
        passed: 41,
        failed: 0,
        skipped: 1,
        durationMs: 8300,
        details: ['engine/physics: 18 passed', 'games/breakout: 12 passed', 'games/shared: 11 passed, 1 skipped'],
      },
      logTail: [
        '[verify] tsc --noEmit … OK',
        '[verify] vitest run … 41 passed, 1 skipped',
        '[verify] corner-hits.test.ts … 500/500 hits contained',
        '[delivery] evidence packaged',
      ],
      limitations: ['Skipped test games/shared/audio.test.ts was already skipped upstream; not related to this change.'],
      confidence: 0.92,
      finalOwnerAction: 'accepted',
    },
    handoffIds: [],
    createdAt: new Date(Date.now() - 86_400_000 * 2).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000 * 2 + 3_600_000).toISOString(),
    startedAt: new Date(Date.now() - 86_400_000 * 2 + 600_000).toISOString(),
    completedAt: new Date(Date.now() - 86_400_000 * 2 + 3_600_000).toISOString(),
  };
  store.upsertTask(done);
  store.addEvent({ type: 'task.created', level: 'info', taskId: doneId, message: `Task created: “${done.title}”` });
  store.addEvent({ type: 'worker.recommended', level: 'info', taskId: doneId, workerId: 'wkr_claude_code', message: 'Claude Code recommended (strength match: bugfix, tests)' });
  store.addEvent({ type: 'approval.approved', level: 'success', taskId: doneId, message: 'Owner approved start' });
  store.addEvent({ type: 'run.started', level: 'info', taskId: doneId, workerId: 'wkr_claude_code', message: 'Claude Code started execution (attempt 1)' });
  store.addEvent({ type: 'verify.passed', level: 'success', taskId: doneId, message: 'Verification passed: 41 tests green' });
  store.addEvent({ type: 'task.completed', level: 'success', taskId: doneId, message: 'Owner accepted delivery — task completed' });

  // -- a ready task and two backlog tasks ------------------------------------
  const ready: Task = {
    id: uid('task'),
    title: 'Add temperature graph to the rack overview page',
    goal: 'Add a temperature graph to the rack overview page of the Home Lab Dashboard, using the existing sensor API. Show the last 24 hours.',
    projectId: homelab.id,
    status: 'ready',
    risk: 'low',
    priority: 'p2',
    scope: ['src/ui/rack-overview', 'src/api/sensors'],
    tags: ['frontend', 'feature'],
    acceptanceCriteria: [
      { id: uid('ac'), text: 'Graph shows last 24h of sensor readings', met: null },
      { id: uid('ac'), text: 'All existing tests pass', met: null },
      { id: uid('ac'), text: 'No console errors in the UI', met: null },
    ],
    assignedWorkerId: null,
    recommendation: {
      workerId: 'wkr_antigravity',
      reasons: [
        'Strength match: frontend, feature',
        'Fast trait fits a low-risk UI feature',
        'Idle and healthy',
      ],
      scores: [
        { workerId: 'wkr_antigravity', score: 10, factors: ['+6 strengths: frontend, feature', '+2 idle', '+2 fast (low risk)'] },
        { workerId: 'wkr_codex', score: 9, factors: ['+6 strengths: frontend, feature', '+2 idle', '+1 fast'] },
        { workerId: 'wkr_claude_code', score: 3, factors: ['+2 idle', '+1 healthy'] },
        { workerId: 'wkr_hermes', score: 0, factors: ['-2 degraded health'] },
      ],
    },
    attempts: 0,
    progress: 0,
    phase: null,
    blockReason: null,
    runPlan: null,
    evidence: null,
    handoffIds: [],
    createdAt: new Date(Date.now() - 3_600_000 * 5).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000 * 5).toISOString(),
    startedAt: null,
    completedAt: null,
  };
  store.upsertTask(ready);
  store.addEvent({ type: 'task.created', level: 'info', taskId: ready.id, message: `Task created: “${ready.title}”` });
  store.addEvent({ type: 'worker.recommended', level: 'info', taskId: ready.id, workerId: 'wkr_antigravity', message: 'Antigravity recommended (strength match: frontend, feature)' });

  const backlog1: Task = {
    id: uid('task'),
    title: 'Write import/export docs for recipe collections',
    goal: 'Write documentation for importing and exporting recipe collections in Recipe Box, including the JSON format.',
    projectId: recipes.id,
    status: 'backlog',
    risk: 'low',
    priority: 'p3',
    scope: ['docs/'],
    tags: ['docs'],
    acceptanceCriteria: [
      { id: uid('ac'), text: 'Docs cover import, export and the JSON schema', met: null },
    ],
    assignedWorkerId: null,
    recommendation: null,
    attempts: 0,
    progress: 0,
    phase: null,
    blockReason: null,
    runPlan: null,
    evidence: null,
    handoffIds: [],
    createdAt: new Date(Date.now() - 3_600_000 * 30).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000 * 30).toISOString(),
    startedAt: null,
    completedAt: null,
  };
  store.upsertTask(backlog1);
  store.addEvent({ type: 'task.created', level: 'info', taskId: backlog1.id, message: `Task created: “${backlog1.title}”` });

  store.addEvent({ type: 'system.seeded', level: 'info', message: 'Command Center initialized with sample projects, workers and history.' });
  store.flushSync();
}
