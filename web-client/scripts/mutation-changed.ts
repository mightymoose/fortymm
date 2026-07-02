/**
 * Run StrykerJS against only the source files changed vs. a base ref.
 *
 * StrykerJS has NO built-in "changed files" / "--since" flag — scoping is done
 * through `mutate`. We compute the changed set with git, combine it with the
 * `!`-exclusions imported from stryker.config.mjs (so the exclusion list lives
 * only there), and run Stryker through its Node API. The API takes `mutate` as
 * a real array — the CLI's comma-separated `--mutate` would split patterns
 * like `*.factory.{ts,tsx}` at the brace-internal comma.
 *
 * When no source file changed we exit 0 (not an error), which keeps this
 * usable as a non-blocking PR check. A run whose changed files are all
 * excluded (e.g. a diff confined to `src/mocks/**`) still starts, but Stryker
 * finds zero mutants and treats that as a `ConfigError` ("No tests were
 * executed") rather than a clean no-op — we catch that specific message below
 * and exit 0 too, since "nothing to mutate" isn't a mutation-testing failure.
 *
 * Run from the web-client/ directory (the npm script and CI both do).
 * Usage: node scripts/mutation-changed.ts [base-ref]   (defaults to origin/main)
 */
import { execSync } from "node:child_process";

import { Stryker } from "@stryker-mutator/core";

import config from "../stryker.config.mjs";

const base = process.argv[2] ?? "origin/main";

// Changed (Added/Copied/Modified/Renamed) .ts/.tsx files under src/, relative
// to web-client/ (Stryker's cwd, hence --relative).
const changed = execSync(
  `git diff --name-only --relative --diff-filter=ACMR "${base}...HEAD" -- src`,
  { encoding: "utf8" },
)
  .split("\n")
  .filter((path) => /\.(ts|tsx)$/.test(path));

if (changed.length === 0) {
  console.log(`No source files changed vs ${base} — skipping mutation run.`);
  process.exit(0);
}

const excludes = (config.mutate ?? []).filter((p) => p.startsWith("!"));

console.log(`Mutating files changed vs ${base} (minus the config's exclusions):`);
console.log(changed.map((p) => `  ${p}`).join("\n"));

// Like the CLI, the API loads stryker.config.mjs itself and merges these
// overrides on top.
try {
  await new Stryker({ mutate: [...changed, ...excludes] }).runMutationTest();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No tests were executed")) {
    console.log(
      "All changed files fell under the config's exclusions — nothing to mutate.",
    );
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
}
