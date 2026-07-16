import fs from 'node:fs';
import path from 'node:path';
import type { Project, RepoHealth, ValidationCommand } from '../../../shared/types';
import type { AppConfig } from '../config';
import { nowIso, uid } from '../domain/util';
import type { Store } from '../store/store';
import { currentBranch, gitTopLevel, revParse, statusPorcelain } from './git';

/**
 * Registered Git project model (P0.2). A registered project is the only
 * thing a real attempt may operate on, and even then only through an
 * isolated worktree — never the owner's primary working tree.
 */

export class ProjectError extends Error {
  readonly statusCode = 422;
}

/** validation-command argv tokens: conservative allowlist, no shell metachars */
const ARGV_TOKEN = /^[A-Za-z0-9_@.\\/:^=,+-]+$/;

export function sanitizeValidationCommands(
  input: Array<{ name: string; argv: string[]; required?: boolean; timeoutMs?: number }>,
  defaultTimeoutMs: number,
): ValidationCommand[] {
  if (input.length > 10) throw new ProjectError('Too many validation commands (max 10).');
  return input.map((c) => {
    const name = String(c.name ?? '').trim().slice(0, 60);
    if (!name) throw new ProjectError('Every validation command needs a name.');
    if (!Array.isArray(c.argv) || c.argv.length === 0 || c.argv.length > 24) {
      throw new ProjectError(`Validation command "${name}" needs 1–24 argv tokens.`);
    }
    for (const token of c.argv) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 200 || !ARGV_TOKEN.test(token)) {
        throw new ProjectError(
          `Validation command "${name}" has an unsafe argv token: ${JSON.stringify(token)}. ` +
            'Tokens are executed directly (no shell); metacharacters are not allowed.',
        );
      }
    }
    return {
      id: uid('vc'),
      name,
      argv: c.argv,
      required: c.required !== false,
      timeoutMs: Math.min(15 * 60_000, Math.max(1_000, Number(c.timeoutMs ?? defaultTimeoutMs))),
    };
  });
}

export function sanitizeProtectedPaths(input: string[]): string[] {
  if (input.length > 50) throw new ProjectError('Too many protected paths (max 50).');
  return input.map((p) => {
    const norm = String(p).replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').trim();
    if (!norm || norm.includes('..') || path.isAbsolute(norm)) {
      throw new ProjectError(`Unsafe protected path: ${JSON.stringify(p)} (repo-relative prefixes only).`);
    }
    return norm;
  });
}

async function inspectRepo(
  repoRoot: string,
  config: AppConfig,
): Promise<{ canonicalRoot: string; branch: string; commit: string; health: RepoHealth; healthDetail: string | null }> {
  if (!path.isAbsolute(repoRoot)) throw new ProjectError('Repository path must be absolute.');
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(repoRoot);
  } catch {
    throw new ProjectError(`Path does not exist: ${repoRoot}`);
  }
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new ProjectError('Repository path is not a directory.');

  // boundary: the app's own data directory (worktrees live there) is off limits
  const dataReal = fs.existsSync(config.dataDir) ? fs.realpathSync.native(config.dataDir) : path.resolve(config.dataDir);
  const rel = path.relative(dataReal, canonicalRoot);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new ProjectError('Refusing to register a repository inside the Command Center data directory.');
  }

  const top = await gitTopLevel(canonicalRoot);
  if (!top) throw new ProjectError('Path is not a Git repository.');
  if (path.resolve(top).toLowerCase() !== path.resolve(canonicalRoot).toLowerCase()) {
    throw new ProjectError(`Register the repository root (${top}), not a subdirectory.`);
  }

  const branch = await currentBranch(canonicalRoot);
  if (branch === 'HEAD') throw new ProjectError('Repository is in detached-HEAD state; check out a branch first.');
  const commit = await revParse(canonicalRoot, branch);
  const dirty = (await statusPorcelain(canonicalRoot)) !== '';
  return {
    canonicalRoot,
    branch,
    commit,
    health: dirty ? 'dirty' : 'ok',
    healthDetail: dirty ? 'The owner working tree has uncommitted changes (attempts are unaffected — they use isolated worktrees).' : null,
  };
}

export async function registerGitProject(
  store: Store,
  config: AppConfig,
  input: {
    name: string;
    repoRoot: string;
    baseBranch?: string;
    validationCommands?: Array<{ name: string; argv: string[]; required?: boolean; timeoutMs?: number }>;
    protectedPaths?: string[];
  },
): Promise<Project> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new ProjectError('Project name is required.');

  const info = await inspectRepo(input.repoRoot, config);
  const baseBranch = input.baseBranch?.trim() || info.branch;
  const baseCommit = await revParse(info.canonicalRoot, baseBranch);

  const duplicate = store.projects.find(
    (p) => p.kind === 'git' && p.git?.canonicalRoot.toLowerCase() === info.canonicalRoot.toLowerCase(),
  );
  if (duplicate) throw new ProjectError(`This repository is already registered as “${duplicate.name}”.`);

  const project: Project = {
    id: uid('gproj'),
    name,
    description: `Local Git repository · ${info.canonicalRoot}`,
    color: '#5ee7d0',
    tags: ['git'],
    createdAt: nowIso(),
    kind: 'git',
    git: {
      repoRoot: input.repoRoot,
      canonicalRoot: info.canonicalRoot,
      baseBranch,
      baseCommit,
      validationCommands: sanitizeValidationCommands(input.validationCommands ?? [], config.validationTimeoutMs),
      protectedPaths: sanitizeProtectedPaths(input.protectedPaths ?? []),
      enabled: true,
      health: info.health,
      healthDetail: info.healthDetail,
      lastVerifiedAt: nowIso(),
    },
  };
  store.upsertProject(project);
  store.addEvent({
    type: 'project.registered',
    level: 'success',
    message: `Git project registered: “${name}” (${baseBranch} @ ${baseCommit.slice(0, 8)})`,
  });
  return project;
}

/** refresh repo health + base commit; downgrades health when the repo is gone */
export async function recheckGitProject(store: Store, config: AppConfig, projectId: string): Promise<Project> {
  const project = store.project(projectId);
  if (!project || project.kind !== 'git' || !project.git) {
    throw new ProjectError('Not a registered git project.');
  }
  try {
    const info = await inspectRepo(project.git.canonicalRoot, config);
    const baseCommit = await revParse(info.canonicalRoot, project.git.baseBranch);
    project.git = {
      ...project.git,
      baseCommit,
      health: info.health,
      healthDetail: info.healthDetail,
      lastVerifiedAt: nowIso(),
    };
  } catch (err) {
    project.git = {
      ...project.git,
      health: fs.existsSync(project.git.canonicalRoot) ? 'error' : 'missing',
      healthDetail: (err as Error).message,
      lastVerifiedAt: nowIso(),
    };
  }
  store.upsertProject(project);
  return project;
}

export function updateGitProject(
  store: Store,
  config: AppConfig,
  projectId: string,
  patch: {
    enabled?: boolean;
    validationCommands?: Array<{ name: string; argv: string[]; required?: boolean; timeoutMs?: number }>;
    protectedPaths?: string[];
  },
): Project {
  const project = store.project(projectId);
  if (!project || project.kind !== 'git' || !project.git) {
    throw new ProjectError('Not a registered git project.');
  }
  if (patch.enabled !== undefined) project.git.enabled = patch.enabled;
  if (patch.validationCommands) {
    project.git.validationCommands = sanitizeValidationCommands(patch.validationCommands, config.validationTimeoutMs);
  }
  if (patch.protectedPaths) project.git.protectedPaths = sanitizeProtectedPaths(patch.protectedPaths);
  store.upsertProject(project);
  store.addEvent({ type: 'project.updated', message: `Git project updated: “${project.name}”` });
  return project;
}
