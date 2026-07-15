# CHUBZ AI Command Center

Local-first mission control for AI coding workers. One place for Chubz to
turn a plain-language goal into a structured task, route it to the right AI
worker, approve the important moments, watch execution live, recover from
blockers, and review hard evidence before accepting the delivery — instead of
juggling separate apps and copy-pasting prompts.

> **Honesty up front:** all worker execution today is produced by a local,
> deterministic **simulation engine**. No external AI is called, no
> credentials are needed, nothing outside this folder is touched. The adapter
> interface where real workers (Claude Code, Codex, Antigravity, Hermes, …)
> plug in later is real and documented — see
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

![stack](https://img.shields.io/badge/stack-TypeScript%20%C2%B7%20Express%205%20%C2%B7%20React%2019%20%C2%B7%20Vite-8b7bff)

## What it does

- **Natural-language intake** — describe a goal ("Urgent: migrate the Games
  Project save-data schema…"); the system structures it into title, project,
  risk (+rationale), priority, tags, scope and acceptance criteria.
- **Explainable worker routing** — a rule engine scores every worker
  (strengths, availability, health, risk fit) and shows *why* one was chosen.
- **Owner approvals** — starting a task, high-risk mid-run changes, and final
  delivery all pause for an explicit approve/reject with notes.
- **Live execution** — phases, step checklist, progress and a streaming log
  console over Server-Sent Events.
- **Blockers & recovery** — pause, resume, cancel, retry, or hand off to
  another worker with a structured context package (goal, completed work,
  remaining work, files, risks, exact next action).
- **Evidence & delivery** — changed files with diff stats, test report, log
  tail, limitations, confidence, and the owner's final decision.
- **Local persistence** — everything (projects, tasks, workers, approvals,
  events, handoffs) survives restarts; interrupted runs are recovered safely
  as blocked-and-retryable.
- **Kanban board, worker roster, approvals inbox, activity feed** — all live.

## Quick start

Requirements: Node.js ≥ 20 (no database, no Docker, no API keys).

```bash
npm install
npm run build     # build the UI once
npm start         # http://localhost:4680  (API + UI, single process)
```

Development (hot reload; UI on :5173 proxying to the API on :4680):

```bash
npm run dev
```

Useful environment variables:

| Variable    | Default                    | Meaning                                   |
| ----------- | -------------------------- | ----------------------------------------- |
| `PORT`      | `4680`                     | API/UI port                               |
| `DATA_FILE` | `data/command-center.json` | where state is persisted                  |
| `SIM_SPEED` | `1`                        | simulation pacing multiplier (2 = 2× fast) |

First launch seeds three sample projects, four workers, and a small history
so the product is demonstrable immediately. Delete `data/` to start fresh.

## Try the full scenario (2 minutes)

1. **＋ New task** → type
   `Urgent: migrate the Games Project save-data schema so player progress can sync across devices`
   → **Structure it** → review the draft (high risk, P0, Claude Code
   recommended with reasons) → **Create task**.
2. **▶ Dispatch worker** → a start approval appears → **Approve**.
3. Watch the run: plan checklist, progress, live logs.
4. The worker pauses itself at a **mid-run gate** (guarded schema change) →
   **Approve**.
5. Attempt 1 hits a realistic **blocker** → **Retry (attempt 2)** (or hand
   off to another worker).
6. Verification passes → task enters **Review** with the full evidence
   package → **Approve** to accept delivery. Done.

Scenario rules (by design, so every path is demonstrable):
low risk → clean run · medium/high risk → one blocker on attempt 1 ·
high risk → an additional mid-run approval gate.

## Testing & checks

```bash
npm test              # 28 unit + API integration tests (vitest + supertest)
npm run typecheck     # strict TS on server and client
npm run build         # production build
```

The integration tests drive the complete lifecycle over the real HTTP API,
including the mid-run gate, blocker, retry, handoff, pause/cancel, illegal
transitions, and crash recovery.

## Project structure

```
shared/types.ts         single source of truth for the domain model
server/
  src/domain/           intake parser, routing engine, lifecycle, handoff
  src/store/            JSON persistence (atomic writes) + seed data
  src/engine/           orchestrator + worker adapters (simulated today)
  src/api/              REST routes + SSE stream
  test/                 vitest suites
client/
  src/lib/              API client, SSE-fed live store, formatting
  src/components/       cards, badges, timeline, log console, evidence panel
  src/views/            Overview · Board · Task detail · Workers · Approvals · Activity
docs/ARCHITECTURE.md    architecture, data model, lifecycle, adapter design
```

## Security posture

- Runs entirely on `localhost`; no telemetry, no outbound calls.
- No secrets anywhere in the codebase or config.
- Simulated workers cannot touch the filesystem outside the app's own data
  file; a future real adapter is designed to run in isolated workspaces with
  owner approval gates (see architecture doc).

## Known limitations

- Worker execution is simulated (see the honesty note above); file diffs and
  test counts in evidence are illustrative artifacts.
- Single owner, no auth — by design for a personal local tool.
- JSON-file persistence is perfect for one user but not concurrent writers;
  the store API is repository-shaped so SQLite can replace it without
  touching callers.
- Board is click-through (no drag-and-drop yet).
- The intake parser is keyword-heuristic; it's intentionally behind the same
  signature an LLM-backed parser would use.

## Next milestone

Implement the first real adapter (`claude-code`) — spawn the Claude Code CLI
in an isolated per-task workspace, stream its output into the existing
RunContext, map exit conditions to `finished`/`blocked`, and diff the
workspace for real evidence.
