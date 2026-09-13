# iOS E2E CI runs the backend as native processes, not Docker

Every other e2e suite in this repo (root `e2e/`, and local iOS runs via
`FMM_API_BASE_URL`) boots the backend with `docker-compose.dev.yml`. The
`ios.yml` CI job runs on GitHub-hosted `macos-latest`, and GitHub-hosted macOS
runners do not support running Docker containers (no nested virtualization) —
this is a platform limitation, not a missing setup step. A third-party
Docker-on-macOS action (e.g. Colima-based) exists but is unofficial and
adds a fragile dependency to CI.

Instead, the `ios.yml` XCUITest job starts the API as native processes on the
runner: Postgres and Redis via Homebrew, with the API run directly using
`uvicorn`. Redis binds to loopback and must answer a readiness check before
the API starts: anonymous guest admission refuses creation when its Redis
budget is unavailable. This mirrors the escape hatch
`api/CLAUDE.md` already documents for skipping testcontainers
(`TEST_DATABASE_URL` against an existing Postgres) — same real-API-no-mocks
philosophy, just without a container layer. Local runs and this project's
cloud sessions keep using `docker-compose.dev.yml`, since both have working
Docker; CI is the only environment that needs the native path.
