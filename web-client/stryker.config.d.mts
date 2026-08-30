/**
 * Types for `stryker.config.mjs`, so `scripts/mutation-changed.ts` is covered by
 * `npm run typecheck` (the package's authoritative TypeScript gate).
 *
 * The config's own JSDoc names `PartialStrykerOptions` from
 * `@stryker-mutator/api`, but that package is a non-hoisted transitive
 * dependency of `@stryker-mutator/vitest-runner` and `@stryker-mutator/core`
 * re-exports neither the type nor a `types` entry. Importing it would mean
 * adding a direct dependency, which is not what this gate is for.
 *
 * So this declares the seam the script actually consumes, and only that:
 * `mutate`, which it reads to reuse the config's `!`-exclusions. Widen it when
 * a consumer needs more, rather than restating the whole option set here.
 */
declare const config: {
  mutate?: string[];
};

export default config;
