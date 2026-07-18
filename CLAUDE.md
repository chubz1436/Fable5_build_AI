# CLAUDE.md — CHUBZ AI Command Center

Context for any Claude session working in this repo. Read this first, then `README.md`,
`docs/ARCHITECTURE.md`, and `git log --oneline` before making recommendations. These notes can go
stale — **verify the live state** (`git branch --show-current`, `git status`, `git log`) rather than
trusting them blindly.

## What this is

Local-first mission control for AI coding workers. This IS the `Fable5_build_AI` repo
(remote: `github.com/chubz1436/Fable5_build_AI`). As of v0.3 it is **repository-backed, Codex-first**:

```
register local git repo → task → exact single-use approval grant → isolated git worktree →
real worker run (Codex CLI or deterministic test runner) → real git diff evidence →
independent validation → owner accept/reject.   Never merges or pushes; owner tree never touched.
```

Stack: TypeScript (strict), Express 5 + SSE, React 19 + Vite, **SQLite WAL** (`node:sqlite`, no native
deps), vitest. Node ≥ 24, Windows. Owner: Chubz (Taglish is welcome).

## Layout

- `shared/types.ts` — single source of truth for the domain model (server + client import it).
- `server/src/db`, `store` — SQLite is the authoritative store; `Store` is the repository facade.
- `server/src/attempts` — `service.ts` (grants, leases, worktree pipeline, recovery), `runners.ts`
  (hardened Codex + deterministic test runner, Windows-aware exec resolver), `validator.ts`.
- `server/src/git`, `security/auth.ts` — git plumbing (execFile only), loopback+token boundary.
- `server/src/engine` — legacy simulated demo path; the real workspace adapters under `adapters/` are
  QUARANTINED (never instantiated — sample tasks always run the SimulatedAdapter; real execution only
  via AttemptService).
- `client/src` — React SPA fed by an SSE store.
- `server/test` — 113 tests (unit + full vertical-slice integration; deterministic test runner).

## Run it

`npm install` (once) → `npm run build` (once) → `npm start`. The console prints a sign-in link
`http://127.0.0.1:4680/auth/<token>`; open it once to set the session cookie. Every `/api` call needs
the token (cookie or `Authorization: Bearer <token>`). Local demo env (auth token, `ATTEMPT_RUNNER`,
`ANTIGRAVITY_CLI`) lives in `../.claude/launch.json`, **outside** this repo (never committed).

Validate: `npm run typecheck`, `npm test`, `npm run build`.

## Save the owner's quota

- **Demo with `ATTEMPT_RUNNER=test`** — makes real git changes + runs real validation with **zero
  model tokens**. Only use the real `codex` runner for an actual authenticated smoke test.
- One focused milestone per session; avoid repeated full rebuild/test cycles; use a smaller model for
  routine edits.

## Git rules

Active branch: `improve/repository-backed-codex-vertical-slice` — **unmerged and unpushed by design**,
left for the owner's review. `main` is what's on GitHub. **Do not merge or push unless Chubz explicitly
asks.** Windows note: Codex is npm-installed → the runnable is `codex.cmd` (never the extensionless
`…\npm\codex` shim). Next planned milestone (don't auto-start): multi-attempt review UX
(attempt history, diff-vs-diff, per-path write scopes).
