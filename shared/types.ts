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
  adapter: 'simulated' | 'claude-code';
  /**
   * Honesty flag: 'simulated' means execution is produced by the local
   * simulation engine; 'real' means a live local integration (detected at
   * boot); 'planned' marks a real integration designed but not yet wired
   * up. Nothing in this app pretends a real integration works.
   */
  integration: 'simulated' | 'real' | 'planned';
  completedTaskCount: number;
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
  | { kind: 'hello'; system: SystemStatus };
