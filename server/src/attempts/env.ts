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
 * Extra keys the real Codex worker needs so a normal `codex login` (ChatGPT
 * token stored under CODEX_HOME, or an API key) keeps working. Nothing here is
 * a Command Center secret; everything else in the parent env is dropped.
 */
export const CODEX_ENV_EXTRA = [
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
];

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
