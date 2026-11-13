# web-client

The repository's `CLAUDE.md` covers the tasks and layout; `README.md` here has the details. This file holds the conventions for code in the web client.

## Answers from the api are parsed with zod, at the boundary

Every conversion at the api boundary is done with zod, in the schema: telling a call's answers apart, camelCase keys, date values and conveniences like them. Never do them by hand in components or helpers.

- A call in `src/api/<resource>.ts` sends its request through `api` (`src/api/client.ts`), takes the body with `bodyOf(...)` as `unknown`, and parses it once with zod. Never read openapi-fetch's `data` or `error` directly.
- A call's possible answers are one zod sum type: `z.discriminatedUnion` when the bodies share a discriminator key, otherwise `z.union`. Code branches on the parsed variant, never on `response.status` and never with hand-written type predicates. A body that matches no variant is an answer of its own (for health, `unknown`), not an exception.
- Each variant's input is the wire shape, bound to the api's OpenAPI document with `fromWire('<SchemaName>')(...)` (`src/api/wire.ts`), so a field renamed, removed or added in `api/openapi.json` fails `web-client:typecheck` once `web-client:api-types` regenerates `schema.gen.ts`.
- Its output is the app's own type, made by `.transform(...)` in the schema (`fetchHealth` returns `Health`). App code and components use the output types, never the wire types in `schema.gen.ts`.
- The boundary is where the wire format stops: past it there are no snake_case keys and no date strings ("I don't want snake case or string dates from the api"). The schema's transform converts snake_case keys to camelCase and date strings to date values. No answer has either yet, so don't build a generic converter before the first field that needs one.

`src/api/health.ts` is the example to copy.

## This device's signing key

`src/device-key.ts` (README "This device's signing key") is the only place the web client makes, keeps or signs with a key.

- The private key is made non-extractable and kept as the `CryptoKey` object in IndexedDB. Never export it, never make it extractable, never keep it as bytes, and never pass it to the core: the core gets the 33-byte public key and the signatures.
- Make the key only inside the append lock (`appendLock`), looking again for a kept key once it holds it. The journal's appends take the same lock.
- A browser that can't make or keep the key is a typed result (`{ ok: false, reason }`), never a thrown error, and never a key that isn't kept.
- Feature code never signs (design 4.3); what makes records does.
- Claims about the real key go in the browser suite (`e2e/tests/device-key.spec.ts`, through `e2e/harness/`); jsdom has no IndexedDB and no real `CryptoKey` to keep.
- To learn which identity this device has without making one (a screen loading), use `keptPublicKey()`, never `deviceKey()`. Opening a page never mints an identity.

## Records and users on this device

`src/storage.ts` (README "Records and users on this device") is the only code that opens the `fortymm-storage` database. Its interface is two functions, `storeRecord(record)` and `loadUser(playerId)`; widen it only when a claim needs it.

- The record's bytes are the source of truth; a row (the user) is a copy of what the core's getters read from it, rebuildable from the records. Never parse record bytes in the app.
- A record and every row it mints are written in one transaction, with strict durability, inside the append lock (`appendLock`). Never write one without the other.
- Failures are typed results (`{ ok: false, reason }`), never thrown, as in `device-key.ts`. A missing row is `null`, not a failure.
- Claims about what is kept go in the browser suite (`e2e/tests/storage.spec.ts`, through `e2e/harness/storage.html`). A screen's component test replaces only the storage it reads (`vi.mock('../storage.ts')`, and `keptPublicKey` for the device's identity), as `src/routes/settings.test.tsx` does.

## The app is kept on the device

The service worker (`offline/`, README "Opening with no connection") keeps every file of the build and answers page loads with the kept `index.html`. Keep it that way:

- Never answer a request under `/api/` from the service worker, and never keep an api answer in it. Data on the device belongs in its own store, with the tasks that add it.
- Don't list files to keep by hand: the build keeps whatever it emitted.
- Never take over or reload a page that is open: no `skipWaiting()`, no reload on `controllerchange`. A new version shows at the next opening.
