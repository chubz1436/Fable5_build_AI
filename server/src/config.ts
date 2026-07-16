import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** repo root = server/src/../.. */
export const repoRoot = path.resolve(here, '..', '..');

export interface AppConfig {
  port: number;
  dataFile: string;
  /**
   * Simulation speed multiplier. 1 = realistic pacing (~1s per step),
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
  /** hard timeout for a single real CLI session */
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
  /**
   * Auto-approve tool permissions so the Antigravity CLI can edit files
   * headless. Required for it to do work; the run is still confined to an
   * isolated sandboxed workspace and gated by owner approval. Set
   * ANTIGRAVITY_SKIP_PERMISSIONS=0 to disable.
   */
  antigravitySkipPermissions: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: Number(process.env.PORT ?? 4680),
    dataFile:
      process.env.DATA_FILE ?? path.join(repoRoot, 'data', 'command-center.json'),
    simSpeed: Math.max(0.1, Number(process.env.SIM_SPEED ?? 1)),
    version: '0.2.0',
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
    ...overrides,
  };
}
