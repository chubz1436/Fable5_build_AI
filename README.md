# CHUBZ AI Command Center

Local-first mission control for AI coding workers — now **repository-backed**.
Register a local Git repository, create a task, approve an exact execution
grant, and a worker runs in an **isolated Git worktree** while the Command
Center captures the **real diff**, runs **independent validation**, and
presents evidence for the owner's accept/reject decision. Nothing is ever
merged or pushed automatically, and the owner's working tree is never touched.

## Support matrix (honest)

| Capability                          | Status |
| ----------------------------------- | ------ |
| Project registration (local git)    | **Real** |
| Git worktree isolation per attempt  | **Real** |
| Exact single-use approval grants    | **Real** (payload-hash + base-commit bound, expiring) |
| Task → Attempt → Operation history  | **Real** (SQLite WAL, durable) |
| Concurrency leases (task/worker/repo) | **Real** (DB unique constraints) |
| Independent validation runner       | **Real** (argv-allowlisted commands, worktree-scoped) |
| Evidence capture (diff/status/logs) | **Real** (from git, never from worker claims) |
| Crash/restart reconciliation        | **Real** (`unknown_outcome`, `blocked_reconciliation`) |
| Local security (loopback + token)   | **Real** |
| Codex adapter (repository attempts) | **Experimental real integration** — code-complete & hardened; classified `unverified` until an authenticated smoke test runs on your machine |
| Deterministic test runner           | **Real** (used by all automated tests; `ATTEMPT_RUNNER=test`) |
| Claude Code / Codex / Antigravity workspace adapters (legacy demo path) | Experimental, unchanged from v0.2 |
| Hermes                              | Simulated only |
| Simulation engine (sample projects) | Real code, clearly labeled simulation |
| Automatic merge / push              | **Not supported by design** |
| Remote / LAN access                 | **Not enabled by default** (loopback bind; refuses non-loopback without explicit token) |

## Quick start

Requirements: Node.js ≥ 24 (built-in SQLite; no native deps), git.

```bash
npm install
npm run build     # build the UI once
npm start
```

On boot the console prints a **sign-in link**:

```
Sign-in  : http://127.0.0.1:4680/auth/<token>
```

Open that link once — it sets a local session cookie and redirects to the app.
The token persists in `data/auth-token.txt`. Every `/api` request requires it
(browser cookie or `Authorization: Bearer <token>`).

## The repository-backed workflow

1. **Projects → Register a local Git repository** (absolute path to the repo
   root). Optionally configure validation commands (structured argv, no
   shell) and protected paths.
2. **＋ New task** → pick the repository project → describe the goal.
3. **Dispatch** → an **exact approval grant** is created: bound to the task
   goal, worker, repository, and current base commit; single-use; expires in
   30 minutes. If the repo moves or the task changes, the grant is void.
4. **Approve** → the Command Center atomically consumes the grant, takes
   task/worker/repo **leases**, creates branch `cc/<attemptId>` and an
   isolated worktree under `data/worktrees/`, and starts the worker there.
5. The worker runs (Codex CLI, or the deterministic test runner); events
   stream live; cancel kills the whole process tree.
6. The Command Center captures the **actual git diff**, checks **protected
   paths**, then **independently runs your validation commands** in the
   worktree. No commands configured → the delivery is **UNVERIFIED** (never
   silently "passed"); a required failure → **FAILED**.
7. **Review**: real changed files, unified diff, validation results, worker
   log tail. Accept (branch stays unmerged for you to merge when you choose),
   request correction (retry = new grant + new attempt), or cancel. Clean up
   the worktree explicitly; the branch is always kept.

After a crash/restart, interrupted attempts are reconciled — a running worker
becomes `unknown_outcome` (never blindly retried), interrupted validation
becomes `blocked_reconciliation` with a one-click "re-run validation only".

### Codex readiness

The Codex path shells out to your locally installed, logged-in `codex` CLI
(`codex exec --json`, workspace-write sandbox, prompt via stdin, no shell
composition). Until you run an authenticated smoke test on your machine it is
honestly labeled experimental; auth/rate-limit/quota failures are classified
and surface as blocked attempts. To demo the full workflow without Codex
credentials, start with `ATTEMPT_RUNNER=test`.

## Configuration

| Variable        | Default                    | Meaning                                        |
| --------------- | -------------------------- | ---------------------------------------------- |
| `HOST` / `PORT` | `127.0.0.1` / `4680`       | non-loopback refuses to start without `AUTH_TOKEN` |
| `AUTH_TOKEN`    | *(generated)*              | overrides the token file                       |
| `DATA_DIR`      | `./data`                   | database, worktrees, token                     |
| `ATTEMPT_RUNNER`| `codex`                    | `test` = deterministic local runner            |
| `CODEX_CLI` / `CODEX_MODEL` | `codex` / *(unset)* | executable + optional model allowlist  |
| `ATTEMPT_TIMEOUT_MS` | `900000`              | hard cap per worker run                        |
| `APPROVAL_TTL_MS` | `1800000`               | start-grant validity                           |
| `SIM_SPEED`     | `1`                        | demo simulation pacing                         |

## Testing

```bash
npm test              # 60 tests: unit + API + full vertical-slice integration
npm run typecheck
npm run build
```

The integration suite registers throwaway git repositories and drives the
entire workflow (register → grant → worktree → real change → real diff →
independent validation → delivery) with the deterministic test runner, and
covers double-approval, lease conflicts, grant expiry/invalidation,
cancellation with process-tree kill, protected paths, secret redaction, and
restart reconciliation. CI (GitHub Actions) runs on Ubuntu and Windows.

## Persistence & data

SQLite (WAL) at `data/command-center.db` is the single authoritative store
(projects, tasks, attempts, operations, leases, approvals, events, handoffs).
A pre-existing `data/command-center.json` from v0.2 is imported once and left
untouched. Back up by copying the `.db` file while the app is stopped.

## Security boundaries

- Loopback-only bind; local token auth on every API call; origin check on
  mutating requests; request-size limits; runtime schema validation (zod);
  no stack traces or secrets in responses; conservative security headers.
- Git and worker processes are spawned with **argument arrays only** — no
  `shell: true` anywhere in the execution path; validation commands are
  argv-allowlisted at registration.
- Worker/validation subprocess env is stripped of `AUTH_TOKEN` and API keys;
  logs are secret-redacted before storage/display.
- Attempts are confined to `data/worktrees/<attemptId>` (containment-checked
  against symlink/junction escape); registered repos must be real git roots
  outside the app's data directory; protected paths are enforced on the diff.
- No merge, no push, no LAN exposure, no telemetry.

## Known limitations

- The real-Codex path awaits an authenticated smoke test on this machine
  (blocked only on owner credentials); all machinery is exercised by the
  deterministic runner.
- One repo-wide write lease per project (no finer-grained scopes yet).
- Reassignment/handoff is not available for repository attempts (retry with
  a new grant instead); it remains available on the simulated demo path.
- Grant consumption re-reads repo HEAD just before the transaction; an
  extremely narrow race with a concurrent local commit remains (documented).
- The legacy workspace adapters (v0.2 demo path) still use their original
  spawn strategy; they are demo-only and slated for migration onto the
  attempt pipeline.

## Next milestone

Authenticated Codex smoke test + first-class multi-attempt review UX:
attempt history list per task, diff-vs-diff comparison between attempts, and
optional per-path write scopes so independent attempts on disjoint areas of
one repository can run concurrently.
