# Dev tools run in Docker

Every build, test, linter, SDK and language toolchain runs in a Docker
container, never on the host. The host needs only Docker, git and
`./bin/mise`, which drives the containers.

The one exception is the iOS client. Xcode and the iOS simulator run only on
macOS, so `ios-client:*` tasks run on the host, and mise installs their tools
(such as XcodeGen) as task `tools`, not globally.

`gcloud` on the host, for the deploy tasks, is the one exception left over
from before this rule. Don't add another.

## Why

- A contributor installs nothing but Docker. Nothing they install for this
  repo can clash with another project's versions.
- Local runs and CI run the same pinned images, so a local pass means a CI
  pass.

## How to tell

- A new task runs a compiler, runtime, SDK or CLI on the host: wrong. Run it
  with `docker compose run` or `docker compose exec` in a service.
- A new tool goes in an image (`Dockerfile`, `mise.container.toml`, or a
  service's own Dockerfile), not in `mise.toml`'s `[tools]` or a host task's
  `tools`, unless the task is `ios-client:*`.
- Instructions that tell a person to install something other than Docker,
  except for the iOS client, are wrong.
- A service that only some tasks need, such as the Android toolchain, sits
  behind a Compose profile, so `docker compose up` doesn't start it.
