import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowlistedChildEnv } from '../attempts/env';

/**
 * Safe git plumbing. Every call is `execFile('git', [...args])` — argument
 * arrays only, no shell, no string composition. Callers pass canonical
 * repository paths that were validated at registration time.
 *
 * Hardening applied to EVERY invocation — a hostile repository must not be
 * able to execute code through us during checkout, staging, snapshotting,
 * diffing, or checkpointing:
 *  - `core.hooksPath` points at a PRIVATE, RANDOMIZED, NON-EXISTENT path that
 *    is re-verified immediately before each call (rotated if anything creates
 *    it), so no repository hook can ever run;
 *  - every configured content filter driver (`filter.<n>.clean/.smudge/
 *    .process`) is enumerated and neutralised, and `.required` forced false,
 *    so clean/smudge/process filters never execute (`.gitattributes` alone
 *    cannot invoke anything when no driver command is defined);
 *  - `core.attributesFile` is cleared and `GIT_ATTR_NOSYSTEM=1` set, removing
 *    the out-of-tree attribute sources;
 *  - `diff.external` is cleared and diff subcommands add
 *    `--no-ext-diff --no-textconv`;
 *  - `core.fsmonitor` is disabled (no long-running fsmonitor child);
 *  - the environment is a MINIMAL ALLOWLIST (not process.env) and cannot
 *    prompt for credentials, open an editor/pager, or reach the network.
 * These `-c` overrides win over repo, global and system config.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  readonly statusCode = 422;
  constructor(message: string, readonly result?: GitResult) {
    super(message);
  }
}

let hooksPathCache: string | null = null;

/**
 * A private, randomized hooks path that is deliberately NEVER created. Git
 * finds no hooks there, and because the name is unguessable a worker cannot
 * pre-populate it. Verified immediately before every git call: if anything
 * ever brings it into existence, we rotate to a fresh random name rather than
 * trusting it (hooks-directory tampering defence).
 */
export function privateHooksPath(): string {
  if (hooksPathCache && !fs.existsSync(hooksPathCache)) return hooksPathCache;
  hooksPathCache = path.join(os.tmpdir(), `chubz-cc-nohooks-${crypto.randomBytes(16).toString('hex')}`);
  return hooksPathCache;
}

/** base overrides that never need repository introspection */
function baseHardeningArgs(): string[] {
  return [
    '-c', `core.hooksPath=${privateHooksPath()}`,
    '-c', 'diff.external=',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.attributesFile=',
  ];
}

/**
 * Discovering WHICH filter drivers exist costs a `git config` call, so the
 * driver-name list is cached per working directory. The neutralising `-c`
 * overrides are still applied to EVERY git invocation — only the name
 * discovery is cached, and the pipeline calls resetFilterDriverCache() at each
 * consequential phase boundary (before worker launch, validation, snapshots
 * and checkpoint) so the enumeration is always fresh where it matters.
 * Introducing a new driver additionally requires a git-config change, which the
 * integrity baseline independently detects and blocks (config_changed).
 */
const DRIVER_CACHE_TTL_MS = 60_000;
const driverCache = new Map<string, { names: string[]; at: number }>();

/** discard cached driver names (call at attempt phase boundaries / in tests) */
export function resetFilterDriverCache(): void {
  driverCache.clear();
}

async function filterDriverNames(cwd: string | undefined): Promise<string[]> {
  if (!cwd) return [];
  const cached = driverCache.get(cwd);
  if (cached && Date.now() - cached.at < DRIVER_CACHE_TTL_MS) return cached.names;
  const names: string[] = [];
  const listed = await rawGit(['config', '--get-regexp', '^filter\\.'], cwd);
  if (listed.code === 0) {
    for (const line of listed.stdout.split('\n')) {
      const m = line.trim().match(/^filter\.(.+)\.(?:clean|smudge|process|required)\s/);
      if (m?.[1] && !names.includes(m[1])) names.push(m[1]);
    }
  }
  driverCache.set(cwd, { names, at: Date.now() });
  return names;
}

/**
 * Neutralise every content-filter driver visible to this repository (system +
 * global + local). A filter only runs when its command is configured, so
 * clearing `clean`, `smudge` and `process` — and forcing `required=false` so a
 * required filter cannot fail the operation instead — makes filter execution
 * impossible regardless of what `.gitattributes` requests.
 */
async function filterNeutralizingArgs(cwd: string | undefined): Promise<string[]> {
  const names = new Set<string>(['lfs']); // always neutralise the common driver
  for (const n of await filterDriverNames(cwd)) names.add(n);
  const args: string[] = [];
  for (const n of names) {
    args.push(
      '-c', `filter.${n}.clean=`,
      '-c', `filter.${n}.smudge=`,
      '-c', `filter.${n}.process=`,
      '-c', `filter.${n}.required=false`,
    );
  }
  return args;
}

/** subcommands that accept diff-content flags: also block textconv/ext-diff */
const DIFF_SUBCOMMANDS = new Set(['diff', 'diff-tree', 'diff-index', 'log', 'show']);

function noExtDiffArgs(args: string[]): string[] {
  return DIFF_SUBCOMMANDS.has(args[0] ?? '') ? ['--no-ext-diff', '--no-textconv'] : [];
}

/**
 * Minimal allowlisted environment for git subprocesses — never process.env, so
 * an injected secret cannot be read by anything git might spawn.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...allowlistedChildEnv(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ATTR_NOSYSTEM: '1',
    // never let git invoke an editor/pager or an askpass helper
    GIT_PAGER: 'cat',
    GIT_ASKPASS: '',
    GIT_SSH_COMMAND: 'false',
  };
}

function execGit(full: string[], cwd: string | undefined, timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      full,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: gitEnv() },
      (err, stdout, stderr) => {
        const raw: unknown = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code : 0;
        resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/**
 * Hardened git WITHOUT filter enumeration — used only for the config read that
 * discovers filter drivers (reading config never runs a filter), so there is
 * no recursion.
 */
function rawGit(args: string[], cwd?: string, timeoutMs = 30_000): Promise<GitResult> {
  return execGit([...baseHardeningArgs(), ...args], cwd, timeoutMs);
}

export async function runGit(args: string[], cwd?: string, timeoutMs = 30_000): Promise<GitResult> {
  const full = [
    ...baseHardeningArgs(),
    ...(await filterNeutralizingArgs(cwd)),
    args[0]!,
    ...noExtDiffArgs(args),
    ...args.slice(1),
  ];
  return execGit(full, cwd, timeoutMs);
}

async function mustGit(args: string[], cwd: string, what: string): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    throw new GitError(`git ${what} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`, r);
  }
  return r.stdout;
}

/** branch names we generate/accept: conservative allowlist, no leading dash */
export function isSafeBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(name) && !name.includes('..');
}

/** repo-relative paths coming back from git must stay relative and inside */
export function isSafeRelPath(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const norm = rel.replaceAll('\\', '/');
  return !norm.split('/').includes('..');
}

export async function gitTopLevel(dir: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '--show-toplevel'], dir);
  if (r.code !== 0) return null;
  const top = r.stdout.trim();
  return top ? fs.realpathSync.native(top) : null;
}

export async function currentBranch(repo: string): Promise<string> {
  return (await mustGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo, 'rev-parse HEAD')).trim();
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return (await mustGit(['rev-parse', '--verify', `${ref}^{commit}`], repo, `rev-parse ${ref}`)).trim();
}

/** porcelain status of the repo/worktree ('' = clean) */
export async function statusPorcelain(repo: string): Promise<string> {
  return (await mustGit(['status', '--porcelain'], repo, 'status')).trimEnd();
}

export async function worktreeAdd(
  repo: string,
  worktreePath: string,
  branch: string,
  baseCommit: string,
): Promise<void> {
  if (!isSafeBranchName(branch)) throw new GitError(`Unsafe branch name: ${branch}`);
  if (!/^[0-9a-f]{7,40}$/i.test(baseCommit)) throw new GitError(`Unsafe base commit: ${baseCommit}`);
  await mustGit(['worktree', 'add', '-b', branch, worktreePath, baseCommit], repo, 'worktree add');
}

export async function worktreeRemove(repo: string, worktreePath: string): Promise<void> {
  await mustGit(['worktree', 'remove', '--force', worktreePath], repo, 'worktree remove');
}

export async function worktreeList(repo: string): Promise<string> {
  return await mustGit(['worktree', 'list', '--porcelain'], repo, 'worktree list');
}

export async function branchOfWorktree(worktree: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktree);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** stage everything in the ATTEMPT worktree so the diff includes new files */
export async function stageAll(worktree: string): Promise<void> {
  await mustGit(['add', '-A'], worktree, 'add -A');
}

export interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
  changeType: 'added' | 'modified' | 'deleted';
}

/** real per-file change stats between baseCommit and the worktree content */
export async function diffNumstat(worktree: string, baseCommit: string): Promise<NumstatEntry[]> {
  const out = await mustGit(['diff', '--numstat', '--find-renames', baseCommit], worktree, 'diff --numstat');
  const status = await mustGit(['diff', '--name-status', '--find-renames', baseCommit], worktree, 'diff --name-status');
  const kind = new Map<string, string>();
  for (const line of status.split('\n')) {
    const m = line.trim().match(/^([A-Z])\S*\t(.+?)(\t(.+))?$/);
    if (m) kind.set(m[4] ?? m[2]!, m[1]!);
  }
  const entries: NumstatEntry[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const rel = m[3]!.replace(/^"|"$/g, '');
    if (!isSafeRelPath(rel)) continue;
    const k = kind.get(rel) ?? 'M';
    entries.push({
      path: rel,
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2]),
      changeType: k === 'A' ? 'added' : k === 'D' ? 'deleted' : 'modified',
    });
  }
  return entries;
}

/** unified diff (size-capped by the caller) */
export async function diffUnified(worktree: string, baseCommit: string): Promise<string> {
  return await mustGit(['diff', '--find-renames', baseCommit], worktree, 'diff');
}

export async function diffStat(worktree: string, baseCommit: string): Promise<string> {
  return (await mustGit(['diff', '--stat', baseCommit], worktree, 'diff --stat')).trimEnd();
}

/**
 * Content snapshot of the worktree (tracked + untracked-not-ignored files):
 * stages everything, then hashes the index into a tree object. Two identical
 * hashes prove byte-identical content; a mismatch pinpoints exactly what a
 * validation run mutated (P0-1). Gitignored files are invisible here — that
 * IS the explicit ignored-output configuration for build artifacts.
 */
export async function writeTreeSnapshot(worktree: string): Promise<string> {
  await stageAll(worktree);
  return (await mustGit(['write-tree'], worktree, 'write-tree')).trim();
}

/** repo-relative paths that differ between two tree snapshots */
export async function diffTreePaths(worktree: string, treeA: string, treeB: string): Promise<string[]> {
  if (!/^[0-9a-f]{7,64}$/i.test(treeA) || !/^[0-9a-f]{7,64}$/i.test(treeB)) {
    throw new GitError('Unsafe tree hash.');
  }
  const out = await mustGit(['diff-tree', '-r', '--name-only', treeA, treeB], worktree, 'diff-tree');
  return out.split('\n').map((l) => l.trim()).filter((l) => l && isSafeRelPath(l));
}

/**
 * App-generated checkpoint commit on the attempt branch (P0-2). The index is
 * already staged by the snapshot; identity is pinned so the commit never
 * depends on (or leaks) the owner's git config, and hooks/signing are
 * disabled because a checkpoint must never be blocked by repo-local hooks.
 * Returns the commit hash, or null when there is nothing to commit.
 */
export async function commitCheckpoint(worktree: string, message: string): Promise<string | null> {
  await stageAll(worktree);
  const staged = await runGit(['diff', '--cached', '--quiet'], worktree);
  if (staged.code === 0) return null; // nothing staged → nothing to preserve
  await mustGit(
    [
      '-c', 'user.name=CHUBZ Command Center',
      '-c', 'user.email=command-center@localhost',
      '-c', 'commit.gpgsign=false',
      'commit', '--no-verify', '-m', message,
    ],
    worktree,
    'commit (checkpoint)',
  );
  return (await mustGit(['rev-parse', 'HEAD'], worktree, 'rev-parse HEAD')).trim();
}

/** true when the object exists in the repository's object store */
export async function commitExists(repo: string, hash: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) return false;
  const r = await runGit(['cat-file', '-e', `${hash}^{commit}`], repo);
  return r.code === 0;
}

export async function headCommit(worktree: string): Promise<string | null> {
  const r = await runGit(['rev-parse', 'HEAD'], worktree);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** true when `worktreePath` is a registered linked worktree of `repo` */
export async function isWorktreeRegistered(repo: string, worktreePath: string): Promise<boolean> {
  const out = await runGit(['worktree', 'list', '--porcelain'], repo);
  if (out.code !== 0) return false;
  const want = fs.existsSync(worktreePath) ? fs.realpathSync.native(worktreePath) : worktreePath;
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p).replaceAll('\\', '/');
  return out.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .some((l) => norm(l.slice('worktree '.length).trim()) === norm(want));
}
