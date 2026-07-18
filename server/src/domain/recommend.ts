import type {
  Priority,
  RiskLevel,
  WorkerProfile,
  WorkerRecommendation,
} from '../../../shared/types';

export interface RoutingInput {
  tags: string[];
  risk: RiskLevel;
  priority: Priority;
}

/**
 * Rule-based routing engine. Scores every worker with explainable factors
 * and returns the ranked result. Deliberately transparent: the factor list
 * becomes the "why this worker" explanation in the UI and in approvals.
 */
export function recommendWorker(
  input: RoutingInput,
  workers: WorkerProfile[],
  /**
   * When present, only these workers may be recommended or ranked. Repository
   * (git) tasks pass the AttemptService-supported set so the UI can never
   * recommend a worker that would be refused at request-start.
   */
  eligibleWorkerIds?: string[],
): WorkerRecommendation {
  const eligible = eligibleWorkerIds
    ? workers.filter((w) => eligibleWorkerIds.includes(w.id))
    : workers;
  if (eligible.length === 0) {
    throw new Error('No worker is available for repository-backed execution.');
  }
  const scored = eligible.map((w) => scoreWorker(input, w));
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) throw new Error('No workers registered.');
  const winner = eligible.find((w) => w.id === top.workerId)!;

  return {
    workerId: top.workerId,
    reasons: buildReasons(input, winner, top.factors),
    scores: scored,
  };
}

function scoreWorker(
  input: RoutingInput,
  worker: WorkerProfile,
): { workerId: string; score: number; factors: string[] } {
  const factors: string[] = [];
  let score = 0;

  const matched = input.tags.filter((t) => worker.strengths.includes(t));
  if (matched.length) {
    const pts = matched.length * 3;
    score += pts;
    factors.push(`+${pts} strengths: ${matched.join(', ')}`);
  }

  if (worker.availability === 'idle') {
    score += 2;
    factors.push('+2 idle');
  } else if (worker.availability === 'busy') {
    score -= 3;
    factors.push('-3 busy on another task');
  } else {
    score -= 100;
    factors.push('-100 unavailable');
  }

  if (worker.health === 'online') {
    score += 1;
    factors.push('+1 healthy');
  } else if (worker.health === 'degraded') {
    score -= 2;
    factors.push('-2 degraded health');
  } else {
    score -= 100;
    factors.push('-100 offline');
  }

  if (input.risk === 'high' && worker.traits.includes('careful')) {
    score += 3;
    factors.push('+3 careful (high-risk fit)');
  }
  if (input.risk === 'medium' && worker.traits.includes('careful')) {
    score += 1;
    factors.push('+1 careful (risk fit)');
  }
  if (input.risk === 'low' && worker.traits.includes('fast')) {
    score += 2;
    factors.push('+2 fast (low risk favors speed)');
  }
  if (input.priority === 'p0' && worker.traits.includes('fast')) {
    score += 2;
    factors.push('+2 fast (urgent priority)');
  }

  return { workerId: worker.id, score, factors };
}

function buildReasons(
  input: RoutingInput,
  winner: WorkerProfile,
  factors: string[],
): string[] {
  const reasons: string[] = [];
  const matched = input.tags.filter((t) => winner.strengths.includes(t));
  if (matched.length) reasons.push(`Strength match: ${matched.join(', ')}`);
  if (input.risk === 'high' && winner.traits.includes('careful')) {
    reasons.push('Careful trait fits a high-risk change');
  }
  if (input.risk === 'low' && winner.traits.includes('fast')) {
    reasons.push('Fast trait fits a low-risk change');
  }
  if (winner.availability === 'idle') reasons.push('Currently idle');
  if (winner.health === 'online') reasons.push('Healthy');
  if (reasons.length === 0) reasons.push(...factors);
  return reasons;
}
