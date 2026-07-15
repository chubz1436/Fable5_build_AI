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
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: Number(process.env.PORT ?? 4680),
    dataFile:
      process.env.DATA_FILE ?? path.join(repoRoot, 'data', 'command-center.json'),
    simSpeed: Math.max(0.1, Number(process.env.SIM_SPEED ?? 1)),
    version: '0.1.0',
    recoverOnBoot: true,
    ...overrides,
  };
}
