# web-client

The repository's `CLAUDE.md` covers the tasks and layout; `README.md` here has the details. This file holds the conventions for code in the web client.

## Answers from the api are parsed with zod, at the boundary

- A call in `src/api/<resource>.ts` sends its request through `api` (`src/api/client.ts`), takes the body with `bodyOf(...)` as `unknown`, and parses it once with zod. Never read openapi-fetch's `data` or `error` directly.
- A call's possible answers are one zod sum type: `z.discriminatedUnion` when the bodies share a discriminator key, otherwise `z.union`. Code branches on the parsed variant, never on `response.status` and never with hand-written type predicates. A body that matches no variant is an answer of its own (for health, `unknown`), not an exception.
- Each variant's input is the wire shape, bound to the api's OpenAPI document with `fromWire('<SchemaName>')(...)` (`src/api/wire.ts`), so a field renamed, removed or added in `api/openapi.json` fails `web-client:typecheck` once `web-client:api-types` regenerates `schema.gen.ts`.
- Its output is the app's own type, made by `.transform(...)` in the schema (`fetchHealth` returns `Health`). App code and components use the output types, never the wire types in `schema.gen.ts`.
- The boundary is where the wire format stops. When the api first sends them, the transforms convert snake_case keys to camelCase and date strings to date values: the user's words are "I don't want snake case or string dates from the api". Neither is needed yet; don't build a generic converter ahead of the first field that needs it.

`src/api/health.ts` is the example to copy.
