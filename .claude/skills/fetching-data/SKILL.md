---
name: fetching-data
description: Fetch server data in web-client/ the fortymm way — share TanStack Query *options objects* (queryOptions factories), not custom-hook logic, following tkdodo's "Creating Query Abstractions". Use whenever you read server data with TanStack Query: adding or changing a query/mutation, a `*-query.ts` file, a `use*` data hook, a `queryOptions`/`queryKey` factory, or wiring cache invalidation. Complements the react-component skill (which owns file layout).
---

# Fetching data in web-client

We follow tkdodo's [Creating Query Abstractions](https://tkdodo.eu/blog/creating-query-abstractions):
**abstract the *configuration*, not the *hook*.** The unit we share is a
TanStack Query **options object** produced by a `queryOptions()` factory —
never a generic wrapper around `useQuery`.

The file layout (which directory a `*-query.ts` lives in, the query → fetcher →
display split) is owned by the **react-component** skill — read it for where
things go. This skill is about what goes *inside* the data layer.

## The one rule

A query is defined by a factory that returns `queryOptions({...})`. Everything
that needs the data spreads that object. Don't wrap `useQuery` in a bespoke hook
that hides its options.

```ts
// src/api/matches.ts
import { queryOptions } from "@tanstack/react-query";

export function matchQueryOptions(matchId: string) {
  return queryOptions({
    queryKey: matchQueryKey(matchId),
    queryFn: async (): Promise<MatchDetails> =>
      unwrap("load match", await api.GET("/v1/matches/{match_id}", {
        params: { path: { match_id: matchId } },
      })),
    retry: false,
    throwOnError: true,
  });
}
```

`queryOptions()` (not a bare object literal) is what preserves type inference
for `select`, `queryClient.getQueryData`, and suspense variants. Prefer it for
every new base factory. (Some older factories — e.g. `matchDetailsQuery` in
`match-details-query.ts` — still return a bare object; new code uses
`queryOptions()`.)

## Colocate four things in one file

Per query, the `*-query.ts` file owns:

1. **A query-key factory** — one exported function, the *only* place the key is
   spelled. Use a structured, hierarchical key so related caches invalidate
   together:
   ```ts
   export const matchDetailsQueryKey = (matchId: string) =>
     [{ scope: "matches", version: "v1", entity: "details", matchId }] as const;
   ```
   (Flat tuple keys like `["players", "recent"] as const` also exist for
   simple, param-less caches — fine, but still behind a named factory.)
2. **The `queryFn`** — hits the API via `api.GET(...)` (openapi-fetch), then
   **parses the payload at the boundary**. `unwrap(label, result)` turns the
   openapi-fetch result into data-or-throw (`src/api/client.ts`); on top of that,
   a Zod `schema.parse(...)` makes it a trusted typed value. The canonical
   example is `matchDetailsResultFromPayload` in `match-details-query.ts`, whose
   `queryFn` runs `matchDetailsSchema.parse(payload)` so a malformed payload fails
   loudly instead of priming a bad cache entry — the web instance of
   `.claude/rules/parse-at-boundaries.md`. (`api.GET` types are compile-time only,
   off `schema.d.ts`; the parse is the runtime guarantee. Some existing queries
   still return the unparsed typed payload — new boundary-critical ones parse.)
3. **The `queryOptions()` factory** (above).
4. **Derived view-model queries** via `select`, layered by *spreading the base
   factory* — the canonical way to add a projection without re-declaring the
   key/fn:
   ```ts
   export const scoreboardQuery = (matchId: string) => ({
     ...matchDetailsQuery(matchId),
     select: selectScoreboard,   // pure payload → View mapping, unit-tested
   });
   ```
   All mapping / label / ordering logic lives in the `select`, tested as pure
   functions (see the react-component skill's query → fetcher → display split).

## Thin custom hooks are fine — thin

A `use*` hook may exist as a convenience, but it must be a one-liner over the
factory with **no extra options surface**:

```ts
export function useMatch(matchId: string) {
  return useQuery(matchQueryOptions(matchId));
}
```

Fetchers usually skip the hook and call `useSuspenseQuery(thingQuery(id))`
directly. Callers that need `select`, `throwOnError`, suspense, etc. spread the
factory and add them at the call site:
`useQuery({ ...matchQueryOptions(id), select: (m) => m.status })`.

## Mutations invalidate via the same key factory

Never hand-write a key at an invalidation site — import the factory so the key
has exactly one source of truth:

```ts
queryClient.invalidateQueries({ queryKey: matchDetailsQueryKey(matchId) });
```

## Anti-patterns (don't)

- **A generic `useQuery` wrapper** that takes `options?: Partial<UseQueryOptions>`.
  It collapses `data` to `unknown` and re-hides the whole API. Share a
  `queryOptions` object instead.
- **Over-parameterized hooks** that grow a new boolean/option every time a
  caller needs a tweak. Expose the options object; let the caller compose.
- **Inlined query keys** in components, `queryFn`s, or `invalidateQueries` —
  always the key factory.
- **Trusting the payload.** `api.GET` is typed off `schema.d.ts` (compile-time
  only). Parse it with Zod in the `queryFn` before it enters the cache.
- **Putting `select`/label/ordering logic in the component.** It belongs in the
  query file's `select`, where it's unit-tested without a DOM.

## Definition of done

From `web-client/`: `npm run lint`, `npm run build` (type-checks), and
`npm run test:run` pass. The `*-query.ts` gets a plain `.test.ts` covering its
`select`/parsing as pure functions.
