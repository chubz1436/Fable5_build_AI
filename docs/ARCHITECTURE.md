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
│  Express 5 (single process, port 4680)                         │
│                                                                │
│  api/routes ──► Engine (orchestrator; owns ALL state changes)  │
│                   │  ▲                                         │
│         RunContext│  │ adapter events (log/phase/progress/     │
│                   ▼  │ requestApproval/blocked/finished)       │
│               WorkerAdapter (simulated today)                  │
│                                                                │
│  Store: JSON document, debounced atomic writes (tmp+rename),   │
│         every mutation broadcast to SSE subscribers            │
└────────────────────────────────────────────────────────────────┘
                data/command-center.json
```

Design principles:

1. **One source of truth** — `shared/types.ts` is imported by server and
   client; there is no duplicated model.
2. **The engine owns state** — adapters *report*, the engine *decides*.
   Every task transition goes through the lifecycle state machine
   (`domain/lifecycle.ts`); illegal jumps are 409s, in tests and in the UI.
3. **Everything explainable** — routing scores carry factor strings, risk
   levels carry rationales, approvals carry recommendations with reasons.
4. **Local and safe by default** — no network calls, no credentials, no
   writes outside the data file.

## Technology choices

| Concern      | Choice                              | Why                                                        |
| ------------ | ----------------------------------- | ---------------------------------------------------------- |
| Language     | TypeScript everywhere (strict)      | one model shared across tiers                              |
| Backend      | Express 5 + tsx                     | tiny, no build step for the server                         |
| Realtime     | Server-Sent Events                  | one-directional updates, auto-reconnect, no ws dependency  |
| Persistence  | single JSON doc, atomic tmp+rename  | zero native deps, human-inspectable, adequate for 1 owner  |
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

### Later: real adapters

A real `claude-code` adapter would, inside `start()`:

1. create an isolated workspace (never a shared checkout),
2. render the task + handoff context into a prompt/spec file,
3. spawn `claude -p …` (or `codex exec`, or an HTTP call to a local model),
4. stream stdout → `ctx.log`, milestones → `ctx.phase`/`ctx.stepDone`,
5. call `ctx.requestApproval` before privileged operations,
6. on exit: diff the workspace, run the project's tests, and call
   `ctx.finished({filesChanged, tests, …})` — or `ctx.blocked(reason)`.

Nothing in the engine, API, store, or UI changes; register the adapter in
`Engine`'s adapter map and set the worker's `adapter` field.

## API surface

```
GET  /api/state                      full snapshot (bootstrap)
GET  /api/stream                     SSE: task/worker/approval/handoff/event patches
POST /api/tasks/parse                NL text → structured TaskDraft (no side effects)
POST /api/tasks                      create task from (edited) draft → status ready
GET  /api/tasks/:id                  task + its events/approvals/handoffs
POST /api/tasks/:id/promote          backlog → ready
POST /api/tasks/:id/request-start    assign worker (or recommended) → start approval
POST /api/tasks/:id/pause|resume|cancel|retry
POST /api/tasks/:id/reassign         {workerId, reason} → structured handoff → run
POST /api/approvals/:id/decision     {decision: approve|reject, note?}
GET  /api/health
```

Domain errors carry status codes (400 intake, 404 not found, 409 lifecycle);
the JSON error body is surfaced verbatim in the UI.

## Persistence

`Store` holds the whole document in memory; every mutation schedules a
debounced (120 ms) **atomic** write — serialize to `*.tmp`, then rename over
the data file — and broadcasts the changed entity to SSE subscribers.
`flushSync()` runs on shutdown signals. Events are capped at 3000 (oldest
trimmed). The store's surface is repository-shaped (`task(id)`,
`upsertTask`, `eventsForTask`, …) so a SQLite implementation can replace it
behind the same methods.

## Security boundaries

- Binds to localhost; single owner; no auth by design.
- No secrets, tokens, or external endpoints anywhere.
- Simulated execution cannot write files; the only disk artifact is the data
  file. Real adapters must keep the isolated-workspace + approval-gate
  contract described above.
- The UI never executes worker-provided content; logs are rendered as text.

## Simulated vs real, precisely

| Real and working                          | Simulated                             |
| ----------------------------------------- | ------------------------------------- |
| Intake parsing (rule-based, local)        | Worker "thinking"/execution           |
| Routing engine + explanations             | File changes & test counts in evidence|
| Lifecycle state machine + approvals       | Blockers (injected by scenario rules) |
| SSE live updates, pause/resume/cancel     |                                       |
| Retry/reassign + structured handoffs      |                                       |
| Persistence, crash recovery, audit log    |                                       |
| Full REST API + tests                     |                                       |
