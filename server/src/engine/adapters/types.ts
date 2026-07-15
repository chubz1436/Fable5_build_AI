import type {
  EventLevel,
  FileChange,
  Handoff,
  RunStep,
  Task,
  TestReport,
  WorkerProfile,
} from '../../../../shared/types';

/** What a worker hands back when a run finishes successfully. */
export interface RunResult {
  summary: string;
  workPerformed: string[];
  filesChanged: FileChange[];
  tests: TestReport;
  logTail: string[];
  limitations: string[];
  /** 0..1 self-assessed confidence */
  confidence: number;
}

/**
 * Everything an adapter may do during a run. The engine implements this and
 * owns all state changes — adapters only report what is happening.
 */
export interface RunContext {
  /** snapshot of the task at run start */
  readonly task: Task;
  readonly worker: WorkerProfile;
  readonly attempt: number;
  /** present when this run started via a reassignment */
  readonly handoff: Handoff | null;
  /** simulation speed multiplier (1 = realistic pacing) */
  readonly simSpeed: number;
  /** true if a mid-run approval was already granted on a previous attempt */
  readonly priorMidrunApproved: boolean;

  log(line: string, level?: EventLevel): void;
  phase(label: string): void;
  progress(pct: number): void;
  plan(steps: RunStep[]): void;
  stepDone(stepId: string): void;
  /**
   * Pause the run until the owner decides. Resolves true on approval.
   * The engine records a real Approval and surfaces it in the UI.
   */
  requestApproval(req: {
    title: string;
    description: string;
    affectedScope: string[];
  }): Promise<boolean>;
  /** Terminal for this run: execution hit a blocker the owner must resolve. */
  blocked(reason: string): void;
  /** Terminal for this run: work done, ready for verification. */
  finished(result: RunResult): void;
}

/**
 * The seam where real integrations plug in.
 *
 * A real adapter (e.g. spawning `claude -p` or `codex exec` as a subprocess
 * in an isolated workspace, or calling a local model over HTTP) implements
 * this same interface: translate the task + handoff context into the tool's
 * input, stream its output into ctx.log/phase/progress, and map its outcome
 * to ctx.finished/ctx.blocked. See docs/ARCHITECTURE.md § Worker adapters.
 */
export interface WorkerAdapter {
  readonly kind: string;
  start(ctx: RunContext): void;
  pause(taskId: string): void;
  resume(taskId: string): void;
  /** Stop silently; the engine records cancellation events itself. */
  cancel(taskId: string): void;
}
