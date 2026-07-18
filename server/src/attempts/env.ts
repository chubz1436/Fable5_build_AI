/**
 * Allowlisted child-process environments (P0-1 / worker env hardening).
 *
 * Every subprocess the Command Center spawns — validators and real workers —
 * receives an environment built from an ALLOWLIST, never a blocklist. Only the
 * base benign variables (plus explicitly named extras) are inherited, so any
 * arbitrary secret variable present in the parent process is excluded by
 * construction. Comparison is case-insensitive (Windows env semantics).
 */

const BASE_ENV_ALLOWLIST = [
  // process discovery / execution
  'PATH', 'PATHEXT', 'COMSPEC', 'SHELL',
  // Windows system locations many tools require
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'OS',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  // per-user locations (npm/node caches and tool state live here)
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  // temp dirs
  'TEMP', 'TMP', 'TMPDIR',
  // benign machine/user identity + locale
  'USERNAME', 'USER', 'USERDOMAIN', 'COMPUTERNAME', 'HOSTNAME', 'LOGNAME',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  // hardware hints used by test runners for parallelism
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
];

const ENV_ALLOWLIST = new Set(BASE_ENV_ALLOWLIST.map((k) => k.toUpperCase()));

/**
 * Codex credential modes.
 *
 *  - 'login_file' (DEFAULT): authentication comes from the on-disk login the
 *    owner created with `codex login` (under CODEX_HOME, default ~/.codex).
 *    NO API-key environment variable is passed to the worker — a key sitting
 *    in the Command Center's environment is never silently handed to a model
 *    subprocess.
 *  - 'api_key': explicit owner opt-in (CODEX_AUTH_MODE=api_key). Only then are
 *    OPENAI_API_KEY and the related endpoint/org variables forwarded.
 */
export type CodexAuthMode = 'login_file' | 'api_key';

/** location of the on-disk codex login; safe (and required) in both modes */
export const CODEX_LOGIN_ENV = ['CODEX_HOME'];

/** forwarded ONLY when the owner opts into API-key authentication */
export const CODEX_API_KEY_ENV = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
];

/** env keys the Codex worker may inherit for the selected credential mode */
export function codexEnvExtra(mode: CodexAuthMode): string[] {
  return mode === 'api_key' ? [...CODEX_LOGIN_ENV, ...CODEX_API_KEY_ENV] : [...CODEX_LOGIN_ENV];
}

/** build a child environment from the base allowlist plus `extra` keys */
export function allowlistedChildEnv(extra: string[] = [], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = new Set([...ENV_ALLOWLIST, ...extra.map((k) => k.toUpperCase())]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(base)) {
    if (allow.has(key.toUpperCase())) env[key] = base[key];
  }
  return env;
}

/** minimal allowlisted environment for validation subprocesses (P0-1) */
export function minimalValidationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = allowlistedChildEnv([], base);
  // deliberate signal to validation tooling: non-interactive, CI-like
  env.CI = '1';
  return env;
}
