import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request, { type Test } from 'supertest';
import { createApp, createContext, type AppContext } from '../src/app';

export const TEST_TOKEN = 'test-token-000000000000000000000000';

export interface AuthedClient {
  get(url: string): Test;
  post(url: string): Test;
  patch(url: string): Test;
  put(url: string): Test;
  delete(url: string): Test;
}

/** every request carries the local access token (bearer) */
export function authedClient(app: ReturnType<typeof createApp>, token = TEST_TOKEN): AuthedClient {
  const wrap =
    (method: 'get' | 'post' | 'patch' | 'put' | 'delete') =>
    (url: string): Test =>
      request(app)[method](url).set('Authorization', `Bearer ${token}`);
  return {
    get: wrap('get'),
    post: wrap('post'),
    patch: wrap('patch'),
    put: wrap('put'),
    delete: wrap('delete'),
  };
}

/** Fresh app + isolated temp data dir (SQLite), fast simulation for tests. */
export function testContext(overrides: Record<string, unknown> = {}): {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  agent: AuthedClient;
  dataDir: string;
  dbFile: string;
} {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-cc-'));
  const dbFile = path.join(dataDir, 'command-center.db');
  const ctx = createContext({
    dataDir,
    dbFile,
    legacyJsonFile: path.join(dataDir, 'command-center.json'),
    worktreesRoot: path.join(dataDir, 'worktrees'),
    authTokenFile: path.join(dataDir, 'auth-token.txt'),
    authToken: TEST_TOKEN,
    simSpeed: 500,
    recoverOnBoot: false,
    realAdapters: false, // tests never probe for local CLIs
    attemptRunner: 'test',
    ...overrides,
  });
  const app = createApp(ctx);
  return { ctx, app, agent: authedClient(app), dataDir, dbFile };
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

/** Initialise a throwaway git repository with one commit; returns its real path. */
export function makeTempGitRepo(files: Record<string, string> = { 'README.md': '# temp\n' }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chubz-repo-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test Owner');
  git('config', 'commit.gpgsign', 'false');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  git('add', '-A');
  git('commit', '-m', 'initial commit');
  return fs.realpathSync(dir);
}
