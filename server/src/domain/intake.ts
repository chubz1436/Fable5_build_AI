import type {
  Priority,
  Project,
  RiskLevel,
  TaskDraft,
  WorkerProfile,
} from '../../../shared/types';
import { recommendWorker } from './recommend';

/**
 * Local, rule-based intake: turns a natural-language goal into a structured
 * task draft (title, project, risk, priority, tags, scope, acceptance
 * criteria) plus a worker recommendation. No external APIs — everything is
 * explainable keyword heuristics, which is enough to demonstrate the flow
 * and can later be swapped for an LLM-backed parser behind the same function
 * signature.
 */

const RISK_HIGH = [
  'migration', 'migrate', 'database', 'schema', 'auth', 'security', 'payment',
  'billing', 'delete', 'drop', 'production', 'deploy', 'credentials', 'secrets',
];
const RISK_MEDIUM = [
  'refactor', 'upgrade', 'dependency', 'dependencies', 'config', 'api',
  'rewrite', 'rename', 'move', 'performance', 'cache',
];

const PRIORITY_P0 = ['urgent', 'asap', 'critical', 'hotfix', 'immediately', 'p0'];
const PRIORITY_P1 = ['important', 'today', 'soon', 'high priority', 'p1'];
const PRIORITY_P3 = ['someday', 'low priority', 'nice to have', 'eventually', 'p3', 'whenever'];

const TAG_RULES: Array<{ tag: string; words: string[] }> = [
  { tag: 'frontend', words: ['ui', 'css', 'component', 'screen', 'page', 'layout', 'button', 'graph', 'chart', 'style', 'frontend', 'responsive', 'mobile'] },
  { tag: 'backend', words: ['api', 'server', 'endpoint', 'database', 'schema', 'backend', 'service', 'queue', 'sensor'] },
  { tag: 'tests', words: ['test', 'tests', 'coverage', 'spec', 'regression', 'flaky'] },
  { tag: 'docs', words: ['docs', 'documentation', 'readme', 'guide', 'document'] },
  { tag: 'refactor', words: ['refactor', 'clean up', 'cleanup', 'restructure', 'simplify', 'rewrite'] },
  { tag: 'bugfix', words: ['fix', 'bug', 'crash', 'error', 'broken', 'jitter', 'glitch', 'wrong'] },
  { tag: 'feature', words: ['add', 'implement', 'build', 'create', 'new', 'support', 'continue'] },
  { tag: 'performance', words: ['slow', 'optimize', 'performance', 'speed up', 'faster', 'lag'] },
  { tag: 'infra', words: ['ci', 'pipeline', 'build system', 'docker', 'infra', 'tooling', 'lint'] },
];

const SCOPE_BY_TAG: Record<string, string> = {
  frontend: 'src/ui',
  backend: 'src/api',
  tests: 'tests/',
  docs: 'docs/',
  infra: 'tooling/',
  performance: 'src/ (hot paths)',
  refactor: 'src/ (targeted modules)',
};

function includesWord(text: string, word: string): boolean {
  // word-boundary match so 'ui' doesn't hit 'build', 'api' doesn't hit 'rapid'
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(text);
}

function detectRisk(text: string): { risk: RiskLevel; rationale: string } {
  const high = RISK_HIGH.filter((w) => includesWord(text, w));
  if (high.length) {
    return { risk: 'high', rationale: `High-risk signals: ${high.join(', ')}` };
  }
  const medium = RISK_MEDIUM.filter((w) => includesWord(text, w));
  if (medium.length) {
    return { risk: 'medium', rationale: `Medium-risk signals: ${medium.join(', ')}` };
  }
  return { risk: 'low', rationale: 'No risky keywords detected; additive or isolated change.' };
}

function detectPriority(text: string): Priority {
  if (PRIORITY_P0.some((w) => includesWord(text, w))) return 'p0';
  if (PRIORITY_P1.some((w) => includesWord(text, w))) return 'p1';
  if (PRIORITY_P3.some((w) => includesWord(text, w))) return 'p3';
  return 'p2';
}

function detectTags(text: string): string[] {
  const tags = TAG_RULES.filter((r) => r.words.some((w) => includesWord(text, w))).map((r) => r.tag);
  return tags.length ? tags : ['feature'];
}

function matchProject(text: string, projects: Project[]): Project | undefined {
  const lower = text.toLowerCase();
  // full-name match first, then any distinctive word of the project name
  return (
    projects.find((p) => lower.includes(p.name.toLowerCase())) ??
    projects.find((p) =>
      p.name
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3 && !['project', 'dashboard'].includes(w))
        .some((w) => includesWord(lower, w)),
    )
  );
}

function makeTitle(text: string): string {
  const firstSentence = text.split(/[.!?\n]/)[0] ?? text;
  let title = firstSentence.trim().replace(/\s+/g, ' ');
  if (title.length > 72) {
    title = `${title.slice(0, 69).replace(/\s+\S*$/, '')}…`;
  }
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function buildCriteria(tags: string[], scope: string[]): string[] {
  const criteria = ['All existing tests pass'];
  if (tags.includes('feature') || tags.includes('bugfix')) {
    criteria.push('New behavior is covered by at least one new test');
  }
  if (tags.includes('frontend')) {
    criteria.push('No console errors; works at mobile and desktop widths');
  }
  if (tags.includes('docs')) {
    criteria.push('Docs reviewed for accuracy against current behavior');
  }
  if (tags.includes('bugfix')) {
    criteria.push('Root cause identified and described in the summary');
  }
  criteria.push(`Change stays within scope: ${scope.join(', ')}`);
  return criteria;
}

export function parseGoal(
  text: string,
  projects: Project[],
  workers: WorkerProfile[],
  explicitProjectId?: string,
): TaskDraft {
  const trimmed = text.trim();
  if (!trimmed) throw new IntakeError('Goal text is empty.');
  if (projects.length === 0) throw new IntakeError('No projects exist yet.');

  const { risk, rationale } = detectRisk(trimmed);
  const priority = detectPriority(trimmed);
  const tags = detectTags(trimmed);
  const project =
    (explicitProjectId ? projects.find((p) => p.id === explicitProjectId) : undefined) ??
    matchProject(trimmed, projects) ??
    projects[0]!;

  const scope = [...new Set(tags.map((t) => SCOPE_BY_TAG[t]).filter((s): s is string => !!s))];
  if (scope.length === 0) scope.push('src/');

  const recommendation = recommendWorker({ tags, risk, priority }, workers);

  return {
    title: makeTitle(trimmed),
    goal: trimmed,
    projectId: project.id,
    risk,
    riskRationale: rationale,
    priority,
    scope,
    tags,
    acceptanceCriteria: buildCriteria(tags, scope),
    recommendation,
  };
}

export class IntakeError extends Error {
  readonly statusCode = 400;
}
