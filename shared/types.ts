/**
 * CHUBZ AI Command Center — shared domain model.
 * Imported by both the server (tsx) and the client (Vite).
 */

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high';
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

/** Task lifecycle. See docs/ARCHITECTURE.md for the transition diagram. */
export type TaskStatus =
  | 'backlog'            // captured, not yet groomed
  | 'ready'              // structured and ready to be dispatched
  | 'awaiting_approval'  // waiting for owner to approve the start
  | 'running'            // a worker is executing
  | 'paused'             // owner paused execution
  | 'blocked'            // execution hit a blocker; needs retry / reassign / cancel
  | 'verifying'          // automated verification (tests, checks) in progress
  | 'review'             // evidence ready; waiting for owner review
  | 'completed'          // owner accepted the delivery
  | 'cancelled'          // owner cancelled
  | 'failed';            // terminally failed (kept for completeness)

export type WorkerAvailability = 'idle' | 'busy' | 'paused' | 'offline';
export type WorkerHealth = 'online' | 'degraded' | 'offline';

export type EventLevel = 'info' | 'success' | 'warning' | 'error';

export type ApprovalType = 'start' | 'midrun' | 'completion';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  description: string;
  /** accent color used in the UI */
  color: string;
  tags: string[];
  createdAt: string;
  /** 'sample' projects exist for the simulated demo; 'git' projects are registered local repositories */
  kind: 'sample' | 'git';
  /** present only when kind === 'git' */
  git: GitProjectInfo | null;
}

/** One safe, structured validation command (argv — never a shell string). */
export interface ValidationCommand {
  id: string;
  name: string;
  /** argv[0] is the executable; no shell interpretation ever happens */
  argv: string[];
  required: boolean;
  timeoutMs: number;
}

export type RepoHealth = 'ok' | 'dirty' | 'missing' | 'error';

export interface GitProjectInfo {
  /** path as registered by the owner */
  repoRoot: string;
  /** fully resolved real path (symlinks/junctions resolved) */
  canonicalRoot: string;
  baseBranch: string;
  /** HEAD of baseBranch at last verification */
  baseCommit: string;
  validationCommands: ValidationCommand[];
  /** repo-relative path prefixes a worker must not touch */
  protectedPaths: string[];
  enabled: boolean;
  health: RepoHealth;
  healthDetail: string | null;
  lastVerifiedAt: string | null;
}

export interface WorkerProfile {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  /** emoji identity shown in the UI */
  avatar: string;
  /** skill tags used by the routing engine, e.g. 'frontend', 'tests' */
  strengths: string[];
  /** soft traits used by the routing engine, e.g. 'careful', 'fast', 'local' */
  traits: string[];
  availability: WorkerAvailability;
  health: WorkerHealth;
  currentTaskId: string | null;
  /** which adapter drives this worker */
  adapter: 'simulated' | 'claude-code' | 'codex' | 'antigravity';
  /**
   * Honesty flag: 'simulated' means execution is produced by the local
   * simulation engine; 'real' means a live local integration (detected at
   * boot); 'planned' marks a real integration designed but not yet wired
   * up. Nothing in this app pretends a real integration works.
   */
  integration: 'simulated' | 'real' | 'planned';
  completedTaskCount: number;
  /** live readiness of the underlying adapter (real adapters only) */
  readiness: WorkerReadiness | null;
}

export type ReadinessState =
  | 'UNAVAILABLE'
  | 'VERSION_UNVERIFIED'
  | 'AUTH_REQUIRED'
  | 'READY'
  | 'DEGRADED'
  | 'BUSY'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'DISABLED';

export interface WorkerReadiness {
  state: ReadinessState;
  executablePath: string | null;
  version: string | null;
  /** 'unknown' until a run proves it either way */
  authStatus: 'ok' | 'required' | 'unknown';
  lastCheckAt: string | null;
  lastError: string | null;
  supportsCancel: boolean;
  sandbox: string | null;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  /** null = not yet checked */
  met: boolean | null;
}

export interface FileChange {
  path: string;
  changeType: 'added' | 'modified' | 'deleted';
  summary: string;
  additions: number;
  deletions: number;
}

export interface TestReport {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  details: string[];
}

/** Evidence package produced when a run finishes and verification passes. */
export interface Evidence {
  request: string;
  summary: string;
  workerId: string;
  workPerformed: string[];
  filesChanged: FileChange[];
  tests: TestReport;
  logTail: string[];
  limitations: string[];
  /** 0..1 self-assessed confidence */
  confidence: number;
  finalOwnerAction: 'accepted' | 'changes_requested' | null;
}

/** One step of a worker's execution plan, shown as a checklist while running. */
export interface RunStep {
  id: string;
  label: string;
  done: boolean;
}

export interface WorkerRecommendation {
  workerId: string;
  reasons: string[];
  scores: Array<{
    workerId: string;
    score: number;
    factors: string[];
  }>;
}

export interface Task {
  id: string;
  title: string;
  /** the owner's original natural-language request */
  goal: string;
  projectId: string;
  status: TaskStatus;
  risk: RiskLevel;
  priority: Priority;
  /** affected areas / paths, shown in approvals */
  scope: string[];
  /** skill tags used for worker routing */
  tags: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  assignedWorkerId: string | null;
  recommendation: WorkerRecommendation | null;
  /** execution attempt counter (retries / handoffs increment it) */
  attempts: number;
  /** 0..100 while running */
  progress: number;
  /** current execution phase label */
  phase: string | null;
  blockReason: string | null;
  /** the executing worker's step plan for the current/last run */
  runPlan: RunStep[] | null;
  evidence: Evidence | null;
  handoffIds: string[];
  /** set when this task targets a registered git project (real execution path) */
  gitProjectId: string | null;
  /** the currently active (or most recent) attempt for git-backed tasks */
  activeAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Approval {
  id: string;
  taskId: string;
  type: ApprovalType;
  title: string;
  /** what will happen if approved */
  description: string;
  risk: RiskLevel;
  affectedScope: string[];
  recommendedAction: 'approve' | 'reject';
  recommendationReason: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;

  // -- exact-grant binding (git-backed executions) --------------------------
  /** attempt this approval authorized (set at consumption for start grants) */
  attemptId: string | null;
  /** git project this approval is bound to */
  projectId: string | null;
  workerId: string | null;
  /** repo HEAD the grant was issued against; consumption fails if it moved */
  baseCommit: string | null;
  /** canonical hash of the exact authorized action payload */
  payloadHash: string | null;
  /** full immutable spec the hash covers (start approvals, P0-4) */
  executionSpec?: ExecutionSpec | null;
  expiresAt: string | null;
  singleUse: boolean;
  consumedAt: string | null;
}

/** Structured context passed when a task moves between workers. */
export interface HandoffContext {
  goal: string;
  currentState: string;
  completedWork: string[];
  remainingWork: string[];
  filesInScope: string[];
  evidenceNotes: string[];
  risks: string[];
  nextAction: string;
}

export interface Handoff {
  id: string;
  taskId: string;
  fromWorkerId: string;
  toWorkerId: string;
  reason: string;
  context: HandoffContext;
  createdAt: string;
}

export interface EventRecord {
  id: string;
  at: string;
  type: string;
  level: EventLevel;
  message: string;
  taskId?: string;
  workerId?: string;
  approvalId?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

/** Full state snapshot served at GET /api/state. */
export interface StateSnapshot {
  projects: Project[];
  tasks: Task[];
  workers: WorkerProfile[];
  approvals: Approval[];
  handoffs: Handoff[];
  attempts: Attempt[];
  /** most recent events, newest first */
  events: EventRecord[];
  system: SystemStatus;
}

export interface SystemStatus {
  startedAt: string;
  version: string;
  /** e.g. 'simulated' or 'simulated + claude-code' */
  engine: string;
  simSpeed: number;
  dataFile: string;
  /**
   * Workers AttemptService can actually drive for repository-backed attempts.
   * The UI must not offer any other worker for a git task — request-start
   * refuses them.
   */
  repoCapableWorkerIds: string[];
}

/** Result of parsing a natural-language request into a draft task. */
export interface TaskDraft {
  title: string;
  goal: string;
  projectId: string;
  risk: RiskLevel;
  riskRationale: string;
  priority: Priority;
  scope: string[];
  tags: string[];
  acceptanceCriteria: string[];
  recommendation: WorkerRecommendation;
}

/** Server-sent event envelope pushed over /api/stream. */
export type StreamMessage =
  | { kind: 'event'; event: EventRecord }
  | { kind: 'task'; task: Task }
  | { kind: 'worker'; worker: WorkerProfile }
  | { kind: 'approval'; approval: Approval }
  | { kind: 'handoff'; handoff: Handoff }
  | { kind: 'attempt'; attempt: Attempt }
  | { kind: 'project'; project: Project }
  | { kind: 'hello'; system: SystemStatus };

// ---------------------------------------------------------------------------
// Durable execution model: Task → Attempt → Operation
// ---------------------------------------------------------------------------

export type AttemptState =
  | 'creating_worktree'
  | 'running'
  | 'validating'
  | 'cancelling'               // owner cancelled; termination not yet proven
  | 'ready_for_review'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'timeout'
  | 'unknown_outcome'          // process fate unprovable after a restart
  | 'blocked_reconciliation';  // needs owner action after recovery

export const ACTIVE_ATTEMPT_STATES: AttemptState[] = [
  'creating_worktree',
  'running',
  'validating',
  // leases stay held while cancelling: they are only released once every
  // child process is proven terminated (P0-3)
  'cancelling',
];

export type ExitReason =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timeout'
  | 'auth_required'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'unavailable'
  | 'unknown';

export type ValidationStatus = 'VERIFIED' | 'FAILED' | 'PARTIAL' | 'UNVERIFIED';

export interface ValidationStepResult {
  id: string;
  name: string;
  argv: string[];
  cwd: string;
  required: boolean;
  startedAt: string;
  endedAt: string | null;
  timeoutMs: number;
  exitCode: number | null;
  status: 'PASSED' | 'FAILED' | 'TIMEOUT' | 'ERROR' | 'SKIPPED' | 'CANCELLED';
  outputTail: string[];
}

// ---------------------------------------------------------------------------
// ExecutionSpec: the complete, canonical description of what a start approval
// authorizes (P0-4). The approval hash covers EVERY consequential field; any
// material change after the grant invalidates it.
// ---------------------------------------------------------------------------

export interface ExecutionSpec {
  taskId: string;
  goal: string;
  scope: string[];
  acceptanceCriteria: string[];
  risk: RiskLevel;
  workerId: string;
  adapter: string;
  model: string | null;
  /** version string reported by the adapter executable at grant time */
  adapterVersion: string | null;
  projectId: string;
  /** canonical repository root (case-normalized on Windows for hashing) */
  repoRoot: string;
  baseBranch: string;
  baseCommit: string;
  protectedPaths: string[];
  validationCommands: Array<{ name: string; argv: string[]; required: boolean; timeoutMs: number }>;
  /** worker sandbox mode, e.g. 'workspace-write' (codex) or 'none' (test runner) */
  sandbox: string;
  /**
   * How the worker authenticates: 'login_file' (on-disk `codex login`, no API
   * key forwarded) or 'api_key' (explicit owner opt-in). Part of the approved
   * spec — switching modes requires a new approval.
   */
  credentialMode: string;
  networkAccess: boolean;
  dependencyInstallAllowed: boolean;
  workerTimeoutMs: number;
  validationDefaultTimeoutMs: number;
}

export interface AttemptValidation {
  status: ValidationStatus;
  steps: ValidationStepResult[];
  completedAt: string | null;
}

/** Real evidence captured from the attempt worktree — never from worker claims. */
export interface AttemptEvidence {
  changedFiles: FileChange[];
  diffStat: string;
  /** unified diff, size-capped — captured AFTER validation, so it represents the actual final worktree */
  diff: string;
  diffTruncated: boolean;
  gitStatus: string;
  protectedViolations: string[];
  workerLogTail: string[];
  /** git tree hash of the worktree content before validation ran (P0-1) */
  preValidationTree?: string | null;
  /** git tree hash after validation ran; differs when validation mutated files */
  postValidationTree?: string | null;
  /** files modified by VALIDATION (not the worker); non-empty blocks VERIFIED */
  validationMutations?: string[];
  /** symlinks/junctions inside the worktree that resolve outside it (P1) */
  symlinkEscapes?: string[];
  /** app-generated checkpoint commit that durably contains this delivery (P0-2) */
  checkpointCommit?: string | null;
}

export interface Attempt {
  id: string;
  taskId: string;
  workerId: string;
  adapter: string; // 'codex' | 'test'
  model: string | null;
  /** registered git project */
  projectId: string;
  baseBranch: string;
  baseCommit: string;
  worktreePath: string | null;
  branchName: string | null;
  approvalId: string;
  state: AttemptState;
  exitReason: ExitReason | null;
  executablePath: string | null;
  executableVersion: string | null;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  failureReason: string | null;
  validation: AttemptValidation | null;
  evidence: AttemptEvidence | null;
  delivery: 'accepted' | 'rejected' | 'correction_requested' | null;
  worktreeCleanedAt: string | null;
  worktreeHealth: 'ok' | 'missing' | 'branch_mismatch' | 'unknown' | null;
  /** exact spec this attempt was authorized against (P0-4) */
  executionSpec?: ExecutionSpec | null;
  /** app-generated commit on the attempt branch containing the validated work (P0-2) */
  checkpointCommit?: string | null;
  /** hash binding the completion approval to this exact evidence (P1) */
  evidenceHash?: string | null;
}

export type OperationKind =
  | 'create_worktree'
  | 'start_worker'
  | 'cancel_worker'
  | 'capture_diff'
  | 'run_validation'
  | 'consume_approval'
  | 'checkpoint'
  | 'integrity_check'
  | 'cleanup_worktree'
  | 'reconcile';

export interface OperationRecord {
  id: string;
  attemptId: string;
  kind: OperationKind;
  /** unique — duplicate submissions cannot re-run the same consequence */
  idempotencyKey: string;
  status: 'running' | 'succeeded' | 'failed' | 'timeout' | 'unknown';
  startedAt: string;
  endedAt: string | null;
  /** structured description of the exact action (JSON argv or action payload) */
  command: string | null;
  exitCode: number | null;
  timeoutMs: number | null;
  error: string | null;
}

export type LeaseKind = 'task' | 'worker' | 'repo';

export interface Lease {
  id: string;
  kind: LeaseKind;
  resourceKey: string;
  attemptId: string;
  acquiredAt: string;
  expiresAt: string;
  releasedAt: string | null;
}
