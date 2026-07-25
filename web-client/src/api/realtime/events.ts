import { z } from 'zod'

/**
 * The boundary for `GET /v1/stream`: a frame's `data` string in, a trusted
 * typed event out (`.claude/rules/parse-at-boundaries.md`).
 *
 * The wire is one unnamed message stream with the kind *inside* `data` — there
 * is no `event:` field — so there is exactly one parser here, and adding a kind
 * later never needs a new listener.
 *
 * ```
 * data: {"v":1,"kind":"dashboard.changed","ts":"2026-07-25T00:26:37.607498Z"}
 * ```
 *
 * The envelope is **strict where a mistake would be silent and lenient where
 * strictness would be self-harm**:
 *
 * - **`v` is strict.** A protocol bump means the fields no longer mean what this
 *   client thinks they mean, so an unknown version is refused as its own
 *   outcome rather than being half-read.
 * - **`kind` is lenient.** A newer server that starts publishing a kind this
 *   build has never heard of decodes to `UNKNOWN_EVENT_KIND` and is handled
 *   coarsely (see `./invalidation`). This mirrors the iOS app's
 *   `LenientRawDecodable` idiom.
 *
 * Nothing here throws. A decode failure drops the one event; it must never take
 * the connection down with it, because a connection lost to a malformed frame
 * takes the dashboard's whole freshness mechanism with it.
 */

/** The only protocol version this build understands. */
export const REALTIME_PROTOCOL_VERSION = 1

/** The kinds the server publishes today. */
export const REALTIME_EVENT_KINDS = ['dashboard.changed', 'resync'] as const
export type RealtimeEventKind = (typeof REALTIME_EVENT_KINDS)[number]

/** What a kind from a newer server decodes to. */
export const UNKNOWN_EVENT_KIND = 'unknown'

export type DecodedEventKind = RealtimeEventKind | typeof UNKNOWN_EVENT_KIND

export interface RealtimeEvent {
  readonly v: typeof REALTIME_PROTOCOL_VERSION
  readonly kind: DecodedEventKind
  readonly ts: string
}

export type RealtimeDecodeFailure =
  /** Not JSON, or not shaped like an envelope at all. */
  | 'malformed'
  /** A well-formed envelope from a protocol this build does not speak. */
  | 'unsupported-version'

export type RealtimeDecodeResult =
  | { readonly ok: true; readonly event: RealtimeEvent }
  | { readonly ok: false; readonly reason: RealtimeDecodeFailure }

const kindSchema: z.ZodType<DecodedEventKind> = z.union([
  z.enum(REALTIME_EVENT_KINDS),
  // Any other *string* is a kind from a newer server, not garbage — degrade,
  // don't reject. A non-string `kind` is a shape error and falls through to
  // `malformed`.
  z.string().transform((): DecodedEventKind => UNKNOWN_EVENT_KIND),
])

const envelopeSchema = z.object({
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  kind: kindSchema,
  // Kept as a plain string, not an instant. Nothing reads it — a hint is
  // idempotent and carries no ordering — so tightening this to an ISO shape
  // would let a harmless timestamp-format change on the server silently stop
  // the dashboard refreshing.
  ts: z.string(),
})

/** Distinguishes "a version we don't speak" from "not an envelope". */
const versionProbeSchema = z.object({ v: z.number() })

/**
 * Decode one SSE frame's `data` payload.
 *
 * Pure and total: every input produces a result, and none of them throw.
 */
export function decodeRealtimeEvent(data: string): RealtimeDecodeResult {
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  const version = versionProbeSchema.safeParse(json)
  if (version.success && version.data.v !== REALTIME_PROTOCOL_VERSION) {
    return { ok: false, reason: 'unsupported-version' }
  }

  const envelope = envelopeSchema.safeParse(json)
  if (!envelope.success) return { ok: false, reason: 'malformed' }

  return { ok: true, event: envelope.data }
}
