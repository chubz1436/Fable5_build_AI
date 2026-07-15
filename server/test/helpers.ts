import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, createContext, type AppContext } from '../src/app';

/** Fresh app + isolated temp data file, fast simulation for tests. */
export function testContext(overrides: Record<string, unknown> = {}): {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  dataFile: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-cc-'));
  const dataFile = path.join(dir, 'db.json');
  const ctx = createContext({
    dataFile,
    simSpeed: 500,
    recoverOnBoot: false,
    ...overrides,
  });
  return { ctx, app: createApp(ctx), dataFile };
}

export async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}
