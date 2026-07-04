# Parse untrusted data at every boundary

Any data entering the app from outside its own memory is **untrusted until parsed**. That
includes:

- network responses (from our API or any third party),
- HTTP request/form bodies,
- URL path params and query strings,
- `localStorage` / `sessionStorage` and other persisted client state,
- uploaded files,
- environment variables and process config.

## The rule

**Parse the input at the boundary, then carry the parsed, typed value inward.** The interior
of the app should only ever hold values that have already been validated at the edge.

- Never cast an `unknown` / `any` (or a `JSON.parse` result) and trust it. A type annotation
  is a compile-time claim, **not** a runtime check — the value can still be anything.
- Turn unstructured input into a trusted typed value **once**, at the edge, and let the type
  system guarantee everything downstream. ("Parse, don't validate.")
- If the input doesn't match, fail loudly at the boundary — reject the request, show an
  inline error, redirect, or throw — rather than letting a malformed value leak inward and
  surface as a confusing failure far from its source.

## The tools we use

The parser is idiomatic to each surface — see the relevant `CLAUDE.md`:

- **API (Python)** → **Pydantic** models validate request/response bodies. See
  `api/CLAUDE.md` ("type the I/O boundaries so errors are caught by the type checker").
- **iOS (Swift)** → **`Codable`** decoding against the generated `ios/Fortymm/Generated/Types.swift`.
- **Web client (TypeScript)** → **Zod** everywhere (forms, URLs, network, storage). See the
  `## Boundaries` and `## Forms` sections of `web-client/CLAUDE.md`.
