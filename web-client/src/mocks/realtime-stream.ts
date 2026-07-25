/**
 * The **parked** `/v1/stream` — what a test harness answers when it has no
 * interest in realtime but the app opens a connection anyway.
 *
 * Every authenticated surface holds a stream open (`routes/_app/route.tsx`), so
 * every test that renders one asks for it. Two harnesses need an answer, and
 * they are mocked two different ways — MSW in vitest (`onUnhandledRequest:
 * 'error'`), inline `page.route` interceptors in the MSW-off Playwright suite —
 * so the *shape* of the answer lives here, in a module with no MSW and no
 * Playwright in it, and each harness serves it its own way.
 *
 * "Parked" means: a valid stream that says nothing and asks not to be
 * reconnected soon. The `retry:` directive is the whole trick — the client takes
 * it as the base of its reconnect delay (`api/realtime/reconnect.ts`, which
 * honours a directive longer than its own escalation cap), so a stub that closes
 * the connection makes the client stand down for an hour rather than
 * reconnect-loop through the rest of the test.
 */

/** An hour: longer than any suite, so a stubbed client reconnects exactly never. */
export const PARKED_STREAM_RETRY_MS = 3_600_000

/**
 * The parked stream as bytes: one `retry:` directive block, no events.
 *
 * Deliberately a complete SSE block (terminated by a blank line) — a trailing
 * partial block is discarded by the reader, so a body missing the second `\n`
 * would park nothing.
 */
export const PARKED_STREAM_BODY = `retry: ${PARKED_STREAM_RETRY_MS}\n\n`

/** The content type a real `EventSourceResponse` sends. */
export const SSE_CONTENT_TYPE = 'text/event-stream'
