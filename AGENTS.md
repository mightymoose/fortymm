# Agent instructions

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `mightymoose/fortymm`.
See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default canonical label vocabulary.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` and `docs/adr/`.
See `docs/agents/domain.md`.

## Mise commands

Run these commands from the repo root. Task definitions live in `mise.toml`;
`ios/mise.toml` adds the Ruby version used by Fastlane.

Run `mise install` to install the root toolchain (Node, Python, Helm, and k3d).
For iOS releases, also run `mise install` from `ios/` to install Ruby.

| Command | Purpose |
| --- | --- |
| `mise run regen-api-types` | Start a fresh API from this checkout and regenerate `web-client/src/api/schema.d.ts`; installs web dependencies if needed. |
| `mise run regen-ios-api-types` | Start a fresh API, normalize nullable OpenAPI fields, and regenerate `ios/Fortymm/Generated/Types.swift` using Swift. |
| `mise run qa-down -- [ID]` | Remove a QA stack's containers, volumes, built images, and automation browsers. Omit ID to use the current branch's stack. |
| `mise run redeploy-uat` | Fetch and merge `origin/main`, deploy its published GHCR Helm charts to the local `fortymm-uat` k3d cluster, and smoke-check UAT. |
| `mise run ios-testflight` | Install Ruby dependencies, increment the iOS build number, build a signed release, and upload it to TestFlight. |
| `mise run release-beta` | Run `redeploy-uat`, then `ios-testflight`; abort if either step fails. |

When API routes or schemas change, run both type-generation tasks and include
the generated files with the change. Both tasks stop their temporary API on exit.
The iOS generator requires the Swift toolchain.

QA cleanup supports `--dry-run` to preview removals, `--all` to remove every QA
stack, and `--prune-cache` to also clear the global Docker build cache. For example:
`mise run qa-down -- --all --dry-run`.

UAT deployment requires Docker, kubectl, Helm, k3d, and published artifacts for
the target commit; it waits for publication rather than building locally.
Run it from `main` or the legacy `uat-deploy` worktree.

TestFlight requires macOS/Xcode, signing credentials, and `ASC_KEY_ID`,
`ASC_ISSUER_ID`, and `ASC_KEY_PATH`. The task loads credentials from the
gitignored `ios/fastlane/.env` when present.
