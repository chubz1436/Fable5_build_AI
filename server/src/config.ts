import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** repo root = server/src/../.. */
export const repoRoot = path.resolve(here, '..', '..');

export interface AppConfig {
  /** bind address — loopback by default; non-loopback requires explicit auth config */
  host: string;
  port: number;

  /** application data directory (db, worktrees, auth token) */
  dataDir: string;
  /** SQLite database (WAL) — the authoritative store */
  dbFile: string;
  /** legacy JSON store; imported once, then left untouched */
  legacyJsonFile: string;
  /** root under which every attempt worktree is created */
  worktreesRoot: string;
  /** local access token file (created on first boot) */
  authTokenFile: string;
  /** explicit token override (env AUTH_TOKEN or tests); otherwise file-based */
  authToken: string | null;

  /**
   * Simulation speed multiplier for the demo engine. 1 = realistic pacing,
   * higher = faster. Tests use a large value so full runs finish in ms.
   */
  simSpeed: number;
  version: string;
  /** when false, skip crash-recovery of interrupted runs (used by tests) */
  recoverOnBoot: boolean;
  /** detect local CLIs at boot and upgrade workers to real adapters */
  realAdapters: boolean;

  /** command used to launch the Claude Code CLI (tests substitute a fake) */
  claudeCommand: string;
  claudeTimeoutMs: number;
  /** command used to launch the Codex CLI (tests substitute a fake) */
  codexCommand: string;
  codexTimeoutMs: number;
  /** optional Codex model override; empty = respect the user's codex config */
  codexModel: string;
  /** command used to launch the Antigravity CLI (tests substitute a fake) */
  antigravityCommand: string;
  antigravityTimeoutMs: number;
  antigravityModel: string;
  antigravitySkipPermissions: boolean;

  // -- repository-backed attempt execution -----------------------------------
  /** 'codex' = real Codex CLI; 'test' = deterministic local test runner */
  attemptRunner: 'codex' | 'test';
  /** start-approval validity window */
  approvalTtlMs: number;
  /** lease TTL; renewed while an attempt makes progress */
  leaseTtlMs: number;
  /** hard cap for one worker execution inside a worktree */
  attemptTimeoutMs: number;
  /** default per-validation-command timeout */
  validationTimeoutMs: number;
  /** cap for stored unified diffs */
  maxDiffBytes: number;
  /** cap for retained worker log lines per attempt */
  maxLogLines: number;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = process.env.DATA_DIR ?? path.join(repoRoot, 'data');
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 4680),

    dataDir,
    dbFile: process.env.DB_FILE ?? path.join(dataDir, 'command-center.db'),
    legacyJsonFile: path.join(dataDir, 'command-center.json'),
    worktreesRoot: path.join(dataDir, 'worktrees'),
    authTokenFile: path.join(dataDir, 'auth-token.txt'),
    authToken: process.env.AUTH_TOKEN ?? null,

    simSpeed: Math.max(0.1, Number(process.env.SIM_SPEED ?? 1)),
    version: '0.3.0',
    recoverOnBoot: true,
    realAdapters: process.env.REAL_ADAPTERS !== '0',

    claudeCommand: process.env.CLAUDE_CLI ?? 'claude',
    claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 600_000),
    codexCommand: process.env.CODEX_CLI ?? 'codex',
    codexTimeoutMs: Number(process.env.CODEX_TIMEOUT_MS ?? 600_000),
    codexModel: process.env.CODEX_MODEL ?? '',
    antigravityCommand: process.env.ANTIGRAVITY_CLI ?? 'agy',
    antigravityTimeoutMs: Number(process.env.ANTIGRAVITY_TIMEOUT_MS ?? 600_000),
    antigravityModel: process.env.ANTIGRAVITY_MODEL ?? '',
    antigravitySkipPermissions: process.env.ANTIGRAVITY_SKIP_PERMISSIONS !== '0',

    attemptRunner: process.env.ATTEMPT_RUNNER === 'test' ? 'test' : 'codex',
    approvalTtlMs: Number(process.env.APPROVAL_TTL_MS ?? 30 * 60_000),
    leaseTtlMs: Number(process.env.LEASE_TTL_MS ?? 15 * 60_000),
    attemptTimeoutMs: Number(process.env.ATTEMPT_TIMEOUT_MS ?? 15 * 60_000),
    validationTimeoutMs: Number(process.env.VALIDATION_TIMEOUT_MS ?? 5 * 60_000),
    maxDiffBytes: 400_000,
    maxLogLines: 2000,

    ...overrides,
  };
}
