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
| Exact single-use approval grants    | **Real** (bound to the full canonical **ExecutionSpec** — goal, scope, criteria, risk, worker, model, repo, base commit, validation commands, protected paths, timeouts, sandbox — re-verified inside the consuming transaction) |
| Durable delivery checkpoints        | **Real** (app-generated commit on the attempt branch before review; cleanup refuses to destroy un-checkpointed work) |
| Authoritative cancellation          | **Real** (`cancelling` state; leases released only after child-process termination is proven) |
| Transactional SSE broadcasts        | **Real** (buffered until COMMIT; discarded on rollback) |
| Task → Attempt → Operation history  | **Real** (SQLite WAL, durable) |
| Concurrency leases (task/worker/repo) | **Real** (DB unique constraints) |
| Independent validation runner       | **Real** (argv-allowlisted commands, worktree-scoped) |
| Evidence capture (diff/status/logs) | **Real** (from git, never from worker claims) |
| Crash/restart reconciliation        | **Real** (`unknown_outcome`, `blocked_reconciliation`) |
| Local security (loopback + token)   | **Real** |
| Codex adapter (repository attempts) | **Real, verified** — an authenticated smoke test on this machine reached a VERIFIED delivery (codex-cli 0.144.4, 2026-07-17) |
| Deterministic test runner           | **Real** (used by all automated tests; `ATTEMPT_RUNNER=test`) |
| Claude Code / Codex / Antigravity workspace adapters (legacy demo path) | **Quarantined** — never instantiated; sample tasks always run the SimulatedAdapter; real execution only via the hardened attempt pipeline |
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
3. **Dispatch** → an **exact approval grant** is created: bound to the full
   canonical **ExecutionSpec** (task goal, scope, acceptance criteria, risk,
   worker, adapter + version, model, repository, base commit, validation
   commands, protected paths, timeouts, sandbox); single-use; expires in
   30 minutes. Any material change — repo moved, task edited, validation
   reconfigured — voids the grant; the hash is recomputed from fresh reads
   inside the consuming transaction.
4. **Approve** → the Command Center atomically consumes the grant, takes
   task/worker/repo **leases**, creates branch `cc/<attemptId>` and an
   isolated worktree under `data/worktrees/`, and starts the worker there.
5. The worker runs (Codex CLI, or the deterministic test runner); events
   stream live. Cancelling puts the attempt into **CANCELLING**, kills the
   whole process tree, and only releases leases / settles the task once
   termination is actually proven.
6. The Command Center snapshots the worktree, then **independently runs your
   validation commands** with a **minimal allowlisted environment** (no
   secrets inherited). A second snapshot detects **every file validation
   itself modified** — any unexpected mutation forces **FAILED** and the
   final diff is re-captured so the evidence shows the actual final worktree.
   Protected paths (case-correct on Windows), symlink/junction escapes and
   git integrity (branch, `.git` link, worktree registration) are checked
   too. No commands configured → **UNVERIFIED** (never silently "passed").
7. Before review, the delivery is committed as an app-generated **checkpoint**
   on the attempt branch — the work survives worktree cleanup by
   construction. **Review**: real changed files, post-validation unified
   diff, validation results, worker log tail. The completion approval is
   bound to the exact evidence hash; any later worktree change or
   re-validation invalidates and replaces it. Accept (branch stays unmerged),
   request correction (retry = new grant + new attempt), or cancel. Cleanup
   refuses to destroy un-checkpointed work unless you explicitly confirm the
   irreversible discard; the branch is always kept.

After a crash/restart, interrupted attempts are reconciled — a running worker
becomes `unknown_outcome` (never blindly retried), interrupted validation
becomes `blocked_reconciliation` with a one-click "re-run validation only".

### Codex readiness

The Codex path shells out to your locally installed, logged-in `codex` CLI
(`codex exec --json`, workspace-write sandbox, prompt via stdin, no shell
composition). This path is **verified on this machine**: an authenticated
smoke test on a disposable repository reached a VERIFIED delivery with
codex-cli 0.144.4 (2026-07-17). Auth/rate-limit/quota failures are classified
and surface as blocked attempts. To demo the full workflow without spending
Codex credits, start with `ATTEMPT_RUNNER=test`.

### Validator execution risk (honest statement)

Validation commands are owner-configured programs executed with your OS
account's privileges inside the attempt worktree. The Command Center limits
the blast radius — argv allowlisting (no shell), a minimal allowlisted
environment (parent secrets are never inherited), per-command timeouts,
cancellation kill, and post-run worktree snapshots that flag every file the
validator modified — but it cannot stop a validation command from reading
anything your OS account can read or making network calls. **Only configure
validation commands you trust**, exactly as you would trust a package.json
test script. Build artifacts a validator legitimately produces should be
gitignored: gitignored outputs are exempt from mutation detection by design.

## Configuration

| Variable        | Default                    | Meaning                                        |
| --------------- | -------------------------- | ---------------------------------------------- |
| `HOST` / `PORT` | `127.0.0.1` / `4680`       | non-loopback refuses to start without `AUTH_TOKEN` |
| `AUTH_TOKEN`    | *(generated)*              | overrides the token file                       |
| `DATA_DIR`      | `./data`                   | database, worktrees, token                     |
| `ATTEMPT_RUNNER`| `codex`                    | `test` = deterministic local runner            |
| `CODEX_CLI` / `CODEX_MODEL` | `codex` / *(unset)* | executable + optional model allowlist  |
| `CODEX_AUTH_MODE` | `login_file`             | `api_key` opts into passing `OPENAI_API_KEY` etc. |
| `ATTEMPT_TIMEOUT_MS` | `900000`              | hard cap per worker run                        |
| `APPROVAL_TTL_MS` | `1800000`               | start-grant validity                           |
| `SIM_SPEED`     | `1`                        | demo simulation pacing                         |

## Testing

```bash
npm test              # 113 tests: unit + API + full vertical-slice integration
npm run typecheck
npm run build
```

The integration suite registers throwaway git repositories and drives the
entire workflow (register → grant → worktree → real change → real diff →
independent validation → checkpoint → delivery) with the deterministic test
runner, and covers double-approval, lease conflicts, ExecutionSpec
mutation-after-grant invalidation (goal/scope/criteria/risk/validation
commands/protected paths/base commit), validation-produced worktree
mutations and secret-environment isolation, checkpoint recoverability after
cleanup, cancellation in every pipeline phase (worktree creation, worker,
validation) with proven process termination, transactional SSE (no phantom
events on rollback), legacy-adapter quarantine, protected paths, secret
redaction, and restart reconciliation. The hardening suite adds: git hook
suppression (a blocking pre-commit hook cannot stop an app checkpoint),
external-diff/textconv suppression, git-integrity tampering detection
(worker-created commits, branch switches, ref/tag/local-config changes),
symlink/junction escape scanning (fail-closed, external targets untouched),
worker-env allowlisting (arbitrary parent secrets are never inherited),
operation-status hygiene (no completed attempt leaves a running operation),
and repository-attempt routing (only AttemptService-supported adapters).
It also proves malicious `clean`/`smudge` filters never execute across
checkout/staging/snapshot/diff/checkpoint (with a control run showing the
driver really was active) and cannot read an injected secret, that a hook
inserted into the hooks path after startup is never executed, that
cancellation kills a **detached background descendant** before its delayed
write lands, and that both Codex credential modes behave as specified.
CI (GitHub Actions) runs on Ubuntu and Windows.

## Persistence & data

SQLite (WAL) at `data/command-center.db` is the single authoritative store
(projects, tasks, attempts, operations, leases, approvals, events, handoffs).
Attempt worktrees live under `data/worktrees/<attemptId>`. Back up by copying
the `.db` file while the app is stopped. (A `data/command-center.json` left
over from an older build is imported once on first boot and then ignored; it
is never written to.)

## Security boundaries

- Loopback-only bind; local token auth on every API call; origin check on
  mutating requests; request-size limits; runtime schema validation (zod);
  no stack traces or secrets in responses; conservative security headers.
- Git and worker processes are spawned with **argument arrays only** — no
  `shell: true` anywhere in the execution path (CLI version detection included;
  it reuses the same hardened Windows-aware resolver + launcher as the attempt
  pipeline); validation commands are argv-allowlisted at registration.
- **Every** git invocation is hardened, so a hostile repository cannot execute
  code through us during checkout, staging, snapshots, diffing or checkpointing:
  - repository **hooks** are disabled via a **private, randomized,
    non-existent** `core.hooksPath` that is re-verified immediately before each
    call and rotated if anything ever creates it (a worker cannot pre-populate
    an unguessable path);
  - **content filters** (`clean`, `smudge`, `process`) are neutralised — every
    configured driver is enumerated and its commands cleared with
    `required=false`, so `.gitattributes` cannot invoke anything;
  - external diff drivers and textconv are disabled (`diff.external=` +
    `--no-ext-diff --no-textconv`), attributes files are cleared
    (`core.attributesFile=`, `GIT_ATTR_NOSYSTEM=1`), fsmonitor is off;
  - the git environment is a minimal allowlist (never `process.env`) that
    cannot prompt for credentials, open an editor/pager, or reach the network.
- **Child-process environments are allowlists, never blocklists.** Validators
  get PATH/system-dirs/temp/locale and nothing else. The Codex worker gets that
  base plus only what its credential mode needs. Arbitrary secrets in the app's
  environment (including `AUTH_TOKEN` and any `*_API_KEY`/`*_SECRET`) are
  excluded by construction. Logs are secret-redacted before storage/display.
- **Codex credentials default to the on-disk login** (`codex login`, located
  via `CODEX_HOME`). An `OPENAI_API_KEY` sitting in the Command Center's
  environment is **not** forwarded to the model subprocess unless the owner
  explicitly opts in with `CODEX_AUTH_MODE=api_key`. The chosen mode is part of
  the approved `ExecutionSpec`, so changing it invalidates outstanding grants.
- **Cancellation kills the whole process tree and proves it.** On Windows the
  tree is terminated with a single `taskkill /T /F` (never the `cmd.exe`
  wrapper first, never a delayed kill, which would orphan the real worker); on
  POSIX workers run in their own process group so the group is signalled.
  Detached/background descendants are covered, and leases are released only
  after the recorded pid is verified gone.
- Attempts are confined to `data/worktrees/<attemptId>` (containment-checked).
  A **fail-closed** symlink/junction/reparse-point scan runs before the worker
  launches, before every validation command, before each checkpoint, and on
  revalidation; any link resolving outside the worktree — or any scan error or
  entry-limit hit — fails the attempt (external targets are read-only-resolved,
  never written through). Registered repos must be real git roots outside the
  app's data directory; protected paths are enforced on the diff with
  case-correct matching on Windows.
- **Git integrity is snapshotted before the worker runs** (HEAD, branch,
  gitdir link, all refs, tags, and local config) and re-verified afterwards and
  before checkpoint: a worker-created commit, a branch switch, or any ref/tag/
  local-config change blocks delivery, and HEAD must equal the approved base
  commit before the app writes its checkpoint. `.git` protection is these
  explicit checks — never diff-based path filtering alone. The task's file
  *scope* field is advisory only and is labeled as such on approvals;
  *protected paths* are enforced.
- Repository attempts may run **only on adapters AttemptService can drive**
  (Codex, or the deterministic test runner). Intake never recommends an
  ineligible worker for a git task, the UI disables them with a clear label,
  and request-start refuses them before any approval or attempt is created.
- No merge, no push, no LAN exposure, no telemetry.

## Known limitations

- One repo-wide write lease per project (no finer-grained scopes yet); the
  task scope field is advisory, not enforced.
- Reassignment/handoff is not available for repository attempts (retry with
  a new grant instead); it remains available on the simulated demo path.
- Grant consumption re-reads repo state (HEAD, adapter version) just before
  the consuming transaction; the hash is re-verified from fresh reads inside
  the transaction, but a concurrent local commit landing in that window
  surfaces as a 409 rather than being prevented.
- Validation commands run with the owner's OS privileges — see “Validator
  execution risk” above; environment isolation and mutation detection reduce
  but do not eliminate that trust requirement.
- The legacy workspace adapters are **quarantined**: their code remains in
  `server/src/engine/adapters/` but the Engine never instantiates the real
  ones, sample tasks always run the SimulatedAdapter, and the Antigravity
  permission bypass defaults to OFF. They stay disabled until migrated onto
  the hardened attempt pipeline.
- Filter-driver *discovery* is cached per repository (re-enumerated at every
  consequential phase boundary); the neutralising overrides themselves are
  applied to every git call, and adding a driver requires a git-config change,
  which the integrity baseline independently detects and blocks.
- After a restart during CANCELLING, child-process termination cannot be
  re-verified; the attempt is settled as cancelled with an explicit note and
  the worktree is preserved for inspection.

## Next milestone

First-class multi-attempt review UX: attempt history list per task,
diff-vs-diff comparison between attempts, and optional per-path write scopes
so independent attempts on disjoint areas of one repository can run
concurrently.
