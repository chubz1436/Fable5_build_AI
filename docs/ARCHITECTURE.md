# Architecture

## Overview

A deliberately small, local-first two-tier app:

```
┌─────────────────────────── browser ───────────────────────────┐
│  React 19 SPA (Vite)                                           │
│  live store: GET /api/state bootstrap + SSE entity patches     │
└───────────────┬────────────────────────────▲───────────────────┘
                │ REST (owner actions)       │ SSE /api/stream
┌───────────────▼────────────────────────────┴───────────────────┐
│  Express 5 (single process, loopback :4680, token-gated /api)  │
│                                                                │
│  api/routes ─┬─► AttemptService  — REAL repository execution   │
│              │     exact grants, DB leases, isolated git       │
│              │     worktrees, independent validation,          │
│              │     durable checkpoints, recovery               │
│              │                                                 │
│              └─► Engine — SAMPLE projects only (SimulatedAdapter│
│                    exclusively; no real CLI can run here)      │
│                                                                │
│  Store facade ──► SQLite (WAL, node:sqlite)                    │
│         transactional; SSE broadcasts published after COMMIT   │
└────────────────────────────────────────────────────────────────┘
                data/command-center.db   +   data/worktrees/<attemptId>
```

Design principles:

1. **One source of truth** — `shared/types.ts` is imported by server and
   client; there is no duplicated model.
2. **The orchestrator owns state** — runners/adapters *report*, the service
   *decides*. Every task transition goes through the lifecycle state machine
   (`domain/lifecycle.ts`); illegal jumps are 409s, in tests and in the UI.
3. **Everything explainable** — routing scores carry factor strings, risk
   levels carry rationales, approvals carry recommendations with reasons.
4. **Evidence over claims** — deliveries are judged by the real git diff and
   independently executed validation, never by what a worker says it did.
5. **Local and safe by default** — loopback-only bind with a local access
   token on every `/api` call; no telemetry; no merge or push; the owner's
   working tree is never touched.

## Technology choices

| Concern      | Choice                              | Why                                                        |
| ------------ | ----------------------------------- | ---------------------------------------------------------- |
| Language     | TypeScript everywhere (strict)      | one model shared across tiers                              |
| Backend      | Express 5 + tsx                     | tiny, no build step for the server                         |
| Realtime     | Server-Sent Events                  | one-directional updates, auto-reconnect, no ws dependency  |
| Persistence  | SQLite WAL via built-in `node:sqlite`| zero native deps; real transactions, UNIQUE/partial-index guarantees |
| Frontend     | React 19 + Vite + hand-rolled CSS   | fast, no UI-kit lock-in, full control of the ops aesthetic |
| State (UI)   | useReducer store fed by SSE         | the server is the store; the client just mirrors it        |
| Tests        | Vitest + supertest                  | unit + real-HTTP integration in one runner                 |

## Data model

Entities (see `shared/types.ts` for the full definitions):

- **Project** — grouping + accent color + tags.
- **Task** — goal (original NL request), title, project, status, risk,
  priority, scope, tags, acceptance criteria, assigned worker,
  recommendation (with per-worker scores), attempts, progress, phase,
  runPlan (step checklist), blockReason, evidence, handoffIds, timestamps.
- **WorkerProfile** — name/role/provider/model/avatar, strengths (skill
  tags), traits (careful/fast/local/…), availability, health, currentTaskId,
  adapter kind, `integration: 'simulated' | 'planned'` (honesty flag),
  completedTaskCount.
- **Approval** — type `start | midrun | completion`, what-will-happen
  description, risk, affected scope, recommended action + reason, status,
  decision note.
- **Handoff** — from/to worker + structured context: goal, current state,
  completed work, remaining work, files in scope, evidence notes, risks,
  exact next action.
- **EventRecord** — append-only audit log; types like `task.created`,
  `worker.recommended`, `approval.requested`, `run.started`, `run.log`,
  `run.phase`, `run.blocked`, `handoff.created`, `verify.passed`,
  `review.ready`, `task.completed`. The UI renders milestones as the
  timeline and `run.log`/`run.phase` as the live console.
- **Evidence** — request, summary, work performed, files changed (+diff
  stats), test report, log tail, limitations, confidence, final owner action.

## Task lifecycle

```
backlog → ready → awaiting_approval → running → verifying → review → completed
                       ↑                │  ↑                   │
                       │            paused  │                   │ changes requested
                       │ rejected       │  │                   ▼
                       └────────────    └→ blocked ←───────────┘
                                            │ retry / reassign → running
cancelled: reachable from every non-terminal state
```

- `awaiting_approval` — a **start approval** is pending.
- `running` may pause itself while a **mid-run approval** is pending (the
  adapter awaits the owner's decision; status stays `running`, phase =
  "Waiting for owner approval").
- `verifying` — post-run checks (types/tests/criteria); produces evidence.
- `review` — a **completion approval** is pending; approve ⇒ `completed`,
  reject ⇒ `blocked` ("owner requested changes") so retry machinery reuses
  the same path.
- On boot, tasks found `running/verifying/paused` (a crash or restart
  happened mid-run) become `blocked` with a clear reason; stale worker
  states are cleared and orphaned mid-run approvals expire. Retry resumes.

## Worker adapters

`server/src/engine/adapters/types.ts` defines the seam:

```ts
interface WorkerAdapter {
  start(ctx: RunContext): void;   // translate task+handoff → tool execution
  pause(taskId): void;
  resume(taskId): void;
  cancel(taskId): void;           // stop silently; engine records events
}
```

`RunContext` is the only capability an adapter gets: `log`, `phase`,
`progress`, `plan`, `stepDone`, `requestApproval() → Promise<boolean>`,
`blocked(reason)`, `finished(result)`. The engine implements it, stamps every
emission with a run token so cancelled/superseded runs can't mutate state,
and owns all persistence and eventing.

### Today: `SimulatedAdapter`

Deterministically seeded per `(taskId, attempt)`. Builds a realistic step
plan from the task's tags, paces steps by `SIM_SPEED`, honors pause/cancel
between (and during) steps, and follows documented scenario rules:

- risk `high` → requests a mid-run owner approval before the guarded step
  (skipped on later attempts if already granted once);
- attempt 1 of `medium`/`high` risk → one realistic blocker (failing tests,
  dependency conflict, or workspace drift) — retry or reassignment succeeds;
- produces evidence artifacts (files + diff stats, test report, limitations,
  confidence) that are **labeled as simulated** in the delivery.

### Real execution: `AttemptService` + `CodexRunner` (the only real path)

Real work happens **only** on the repository-backed pipeline
(`attempts/service.ts`), never through the Engine. `attempts/runners.ts`
provides the runners:

- **`CodexRunner`** drives the locally installed `codex` CLI:
  `codex exec --json --color never --skip-git-repo-check --sandbox
  workspace-write [-m MODEL] -`, with the brief piped over **stdin** so no
  task text ever reaches a command line. Codex may run shell commands inside
  its sandbox while writes stay confined to the attempt worktree (passed as
  `cwd`, never as an argument). Exit code 0 is success; failing exits are
  refined into `auth_required` / `rate_limited` / `quota_exhausted` by
  keyword, never the reverse.
  Credentials: **`login_file` by default** — authentication comes from the
  owner's on-disk `codex login` (under `CODEX_HOME`) and an `OPENAI_API_KEY`
  present in the app's environment is *not* forwarded. `CODEX_AUTH_MODE=api_key`
  is an explicit opt-in that additionally passes the API-key variables. The
  chosen mode is recorded in the `ExecutionSpec`, so switching it invalidates
  outstanding grants.
- **`TestRunner`** (`ATTEMPT_RUNNER=test`) is a deterministic local runner
  that spawns a real child process making real file changes — used by the
  automated suite and for zero-token demos.

Both are launched through the hardened Windows-aware resolver + `spawnSafe`
(argv arrays, PATHEXT-correct `.cmd` handling, never `shell: true`), with
allowlisted environments, bounded and secret-redacted logs, hard timeouts,
and whole-process-tree cancellation.

### Quarantined: the legacy v0.2 workspace adapters

`engine/adapters/claude-code.ts`, `codex.ts` and `antigravity.ts` remain in
the tree but are **never instantiated**. They predate the hardened pipeline
(no leases, no Attempt/Operation records, no exact grants, no independent
verification) and are disabled until migrated onto `AttemptService`. The
Engine registers the `SimulatedAdapter` only, so a sample task cannot spawn a
real CLI regardless of what is installed or how a worker is configured; the
Antigravity permission bypass additionally defaults to off.

Boot-time `enableRealAdapters()` still probes for installed CLIs via
`detectCli` (itself shell-free, reusing the hardened resolver/launcher), but
its only effect is honest readiness reporting and marking which workers are
eligible for **repository** attempts.

Honesty guarantees: acceptance criteria are left unjudged (`met: null`) so the
owner inspects the real diff; real processes cannot be paused portably, so
pause is refused for repository attempts with a clear message.

## API surface

Every `/api` route requires the local access token.

```
GET  /api/state                      full snapshot (bootstrap; includes
                                     system.repoCapableWorkerIds for the UI)
GET  /api/stream                     SSE: task/worker/approval/attempt/project patches
POST /api/tasks/parse                NL text → structured TaskDraft (no side effects;
                                     git projects rank only repo-capable workers)
POST /api/tasks                      create task from (edited) draft → status ready
GET  /api/tasks/:id                  task + its events/approvals/handoffs/attempts/operations
POST /api/tasks/:id/promote          backlog → ready
POST /api/tasks/:id/request-start    assign worker (or recommended) → start approval
POST /api/tasks/:id/pause|resume|cancel|retry
POST /api/tasks/:id/reassign         {workerId, reason} → structured handoff → run
POST /api/approvals/:id/decision     {decision: approve|reject, note?}
POST /api/projects/register          register a local git repository
POST /api/projects/:id/recheck       re-verify repo health
PATCH /api/projects/:id              enable/disable, validation commands, protected paths
GET  /api/attempts/:id               attempt + its operations
POST /api/attempts/:id/revalidate    re-run validation only (never the worker)
POST /api/attempts/:id/cleanup       {confirmDiscard?} remove worktree (branch kept)
GET  /api/health
```

Domain errors carry status codes (400 intake, 404 not found, 409 lifecycle);
the JSON error body is surfaced verbatim in the UI.

## Persistence

**SQLite (WAL) is the single authoritative store** (`server/src/db/db.ts`,
Node's built-in `node:sqlite` — zero native dependencies). Domain entities
are JSON documents with constraint-relevant columns lifted out; operational
tables (attempts, operations, leases) are fully typed with UNIQUE and
partial-index guarantees. Foreign keys are on; an integrity check runs at
boot; every state transition that must be atomic runs in `BEGIN IMMEDIATE`
transactions; events are an append-oriented log with a bounded tail. A
legacy v0.2 `command-center.json` is imported once (never modified or
deleted). The `Store` facade keeps the repository-shaped surface
(`task(id)`, `upsertTask`, `eventsForTask`, …) and still broadcasts every
mutation to SSE subscribers.

## Security boundaries

- Binds to loopback only; every `/api` request requires the local access
  token (session cookie or `Authorization: Bearer`), mutating requests are
  origin-checked, and a non-loopback bind refuses to start without an
  explicit `AUTH_TOKEN`.
- No telemetry and no external endpoints. Worker/validator/git subprocesses
  receive allowlisted environments, so app secrets are never inherited.
- Simulated execution cannot write files. Real execution writes only inside
  `data/worktrees/<attemptId>`, behind an exact approval grant.
- Every git invocation runs with repository hooks disabled (private
  randomized, re-verified hooks path), content filters (clean/smudge/process)
  neutralised, external diff/textconv disabled, and a minimal allowlisted
  environment — a hostile repository cannot execute code through us.
- The UI never executes worker-provided content; logs are rendered as text.

## Simulated vs real, precisely

| Real and working                                                        | Simulated / quarantined                           |
| ------------------------------------------------------------------------ | ------------------------------------------------- |
| SQLite WAL persistence; Task→Attempt→Operation durable model             | Hermes execution (simulated, labeled)              |
| Git project registry + per-attempt worktree isolation                    | Sample-project runs (simulation engine, labeled;   |
| Exact single-use approval grants bound to the full ExecutionSpec         |   ALWAYS simulated — never a real CLI)             |
| DB leases (task/worker/repo) + idempotent dispatch                       | Legacy v0.2 workspace adapters: QUARANTINED —      |
| Codex repository runner: real, verified by an authenticated smoke test   |   never instantiated by the Engine; disabled until |
| Real post-validation git diff evidence + protected-path enforcement      |   migrated onto the hardened attempt pipeline      |
| Independent validation runner (allowlisted env, mutation detection)      |                                                    |
| Durable checkpoint commits + loss-refusing cleanup                       |                                                    |
| Authoritative cancellation (CANCELLING; proven termination)              |                                                    |
| Crash reconciliation (`unknown_outcome`, re-validate without re-run)     |                                                    |
| Hardened git (hooks/filters/ext-diff off) + baseline tamper detection    |                                                    |
| Allowlisted worker/validator/git env; fail-closed symlink escape scan    |                                                    |
| Codex login-file credentials by default (API-key env is opt-in)         |                                                    |
| Local security boundary (loopback + token + origin + zod)                |                                                    |
| Transactional SSE live updates; full REST API + 98 tests                 |                                                    |

## Repository-backed execution (v0.3)

```
Projects registry ──► Task (gitProjectId) ──► exact approval grant
      │                                            │ approve (tx: consume grant +
      │                                            ▼  leases + attempt row)
      │                              AttemptService pipeline
      │      ┌──────────────┬──────────────┬──────────────┬───────────────┬──────────────┐
      │      │ create        │ run worker   │ snapshot +   │ validation    │ post-run     │
      └────► │ worktree      │ (Codex/test  │ capture diff │ (argv only,   │ snapshot +   │──► checkpoint
             │ cc/<attempt>  │ runner)      │ + protected  │ allowlisted   │ FINAL diff + │    commit ──► review
             │ containment-  │ tree-kill    │ paths        │ env, abort-   │ mutation     │    (accept /
             │ checked       │ cancel       │              │ able)         │ detection    │    correction)
             └──────────────┴──────────────┴──────────────┴───────────────┴──────────────┘
        cancellation checkpoints between every phase; leases release only after proven termination
```

Key modules: `db/db.ts` (SQLite WAL + migrations + legacy import),
`git/git.ts` (execFile-only plumbing; EVERY call forces an empty `core.hooksPath`,
`diff.external=`, `--no-ext-diff --no-textconv`, no-fsmonitor, and a
non-interactive/no-network git env), `git/projects.ts` (registry + sanitizers),
`attempts/service.ts` (grants, leases, pipeline, recovery, cleanup, routing),
`attempts/runners.ts` (TestRunner + hardened CodexRunner + redaction + safe
spawning), `attempts/env.ts` (allowlisted child environments — validator and
worker), `attempts/validator.ts` (independent checks + fail-closed per-command
containment guard), `attempts/integrity.ts` (pre-execution git baseline +
tamper verification + fail-closed symlink/junction escape scan),
`security/auth.ts` (token + origin + headers). Attempt states:
`creating_worktree → running → validating → ready_for_review →
accepted|rejected`, plus `cancelling | cancelled | failed | timeout |
unknown_outcome | blocked_reconciliation`. Every consequential step is an
Operation row with a unique idempotency key; leases live behind partial
unique indexes so duplicate dispatch and overlapping executions are
impossible at the database level. Start approvals persist their full
ExecutionSpec and its hash; completion approvals are bound to the final
evidence hash + checkpoint commit and are invalidated/replaced by any
worktree change or re-validation. Store broadcasts are buffered inside
transactions and published only after COMMIT. Acceptance never merges or
pushes; worktree cleanup refuses to destroy work that lacks a verified
durable checkpoint (unless the owner explicitly confirms discard) and always
keeps the attempt branch.
