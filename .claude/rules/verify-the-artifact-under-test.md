# Verify the artifact under test is the one you changed

A green result is a claim about **some** artifact. It is only evidence about **your** change
if the thing that ran was built from it. In this repo that has been false often enough, and
in enough different ways, that it deserves its own rule: nearly every "it passed locally but
broke in CI" and every "the demo proved nothing" traced back to a layer serving something
older than the edit.

## The rule

Before you believe a green run, establish two things:

1. **Provenance** — the bundle, image, container, module or binary that ran was produced
   from the working tree you just edited.
2. **Coverage** — the number of tests/specs that *ran* matches the number *collected*. A
   suite that silently skipped a whole project is not a green suite.

If you can't establish both, the result is `INCONCLUSIVE`, not `PASS`.

## The caches that lie

Each of these has produced a false green here at least once. They fail *silently* — no
error, just stale output.

| Layer | How it lies | How to defeat it |
| --- | --- | --- |
| **Docker BuildKit** | `up --build` serves a cached image without your change | Check the *served* asset (bundle, `openapi.json`) actually contains the feature; `--no-cache` if not |
| **PWA service worker** | Browser keeps the old `index.html` after a rebuild | Unregister the service worker + clear caches, or you QA the previous commit |
| **Vite dev server** | A reused server serves the old transform, so a fail-then-pass demo passes in *both* states | Restart vite between the red and green states of a regression proof |
| **`node_modules/.vite` (vitest)** | A stale cache makes `vitest run` **silently skip the newest test files** — the run is green, the count is lower, and nothing names what was dropped | `rm -rf web-client/node_modules/.vite`, then check "Test Files N passed" against `vitest list --filesOnly` |
| **Xcode incremental build** | Reports `BUILD SUCCEEDED` while serving a stale dylib | `rm -rf ios/build/sim` before the build that counts, or check the dylib mtime |
| **MSW** | Left on, it intercepts the `page.route` stubs an e2e run depends on, false-redding unrelated specs | A hand-started vite reused by Playwright must set `VITE_ENABLE_MSW=false` |
| **Playwright reporter** | "N passed" can under-report — a whole project (e.g. mobile) never ran | Check "N passed" against `--list`'s collected total |
| **Worktree tooling** | An untrusted `mise.toml` makes `npx` exit 127; the step "passes" having run nothing | Run `mise exec -- node_modules/.bin/<tool>` and **check the exit code**. The bare path is not enough — `node` itself is off `PATH`, so it exits 127 too. `mise trust` once per worktree |
| **A pipe** | zsh reports the **last** element's status, so `npm install … \| tail` prints `command not found` and still exits 0 | Never pipe a command whose exit code matters. Capture to a file and read it, or check `${PIPESTATUS[0]}` |
| **A shared dev port** | A listener already answering on a well-known port (e.g. `:8000`) is not proof it came from your working tree — another checkout's compose stack or a stale hand-run server answers identically | Bind fresh and never reuse: `scripts/ensure-api-up.sh` starts its own server on its own port every invocation instead of probing for one already up |

## Corollaries

- **A test you have not seen fail is not evidence.** Run the falsification: break the
  implementation deliberately and confirm the test reds *for the stated reason*. This is the
  only way to distinguish a real assertion from one that was weakened to fit the code.
- **An undiscriminated timeout-red proves nothing.** "Timed out after 5000ms" cannot
  distinguish "the guard worked" from "the harness never got there". Vary one thing at a
  time, or probe state at failure time.
- **A green suite and a working product are different claims.** Neither discharges the
  other; this is why the work order carries `## Testing notes` separately from each chore's
  `Verify` command.

The per-layer tooling that implements this lives in each unit's `CLAUDE.md`; this file is
the *why*.
