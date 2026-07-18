import { defineConfig } from 'vitest/config';

/**
 * The suite is mostly INTEGRATION tests: they create real git repositories and
 * worktrees, spawn real child processes (workers, validators, git), and drive
 * the full attempt pipeline. Vitest's 5s default is unrealistic for that and
 * made results depend on machine load rather than behaviour, so the per-test
 * budget is raised. Individual tests still set tighter waits via `waitFor`,
 * which is what actually asserts liveness.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
