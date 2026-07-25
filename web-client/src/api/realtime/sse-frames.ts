/**
 * A Server-Sent Events frame reader: bytes in, decoded frames out.
 *
 * This is the one place the wire format of `GET /v1/stream` is understood. It is
 * deliberately pure — no DOM, no timers, no network, no `EventSource` — because
 * the interesting failures are all *framing* failures (a chunk boundary landing
 * mid-field, a `\r` split from its `\n`, a keepalive comment mistaken for an
 * event), and those are only cheap to test when the reader takes a byte stream
 * and nothing else.
 *
 * Follows the WHATWG "event stream interpretation" algorithm, with two
 * deliberate departures:
 *
 * - **`id:` is parsed and dropped.** Our hints are idempotent and carry no
 *   sequence, so a reconnect self-heals by refetching rather than by replaying
 *   from a `Last-Event-ID` cursor (see the dashboard-invalidation ADR). Keeping
 *   an id would imply a replay log the server does not have.
 * - **`retry:` is surfaced to the caller** as its own frame, rather than being
 *   swallowed as connection state. The server sends one as the very first frame
 *   (jittered), and the reconnect policy that honours it lives above this
 *   module.
 */

/** The reconnect base delay the server asked for, in milliseconds. */
export interface SseRetryFrame {
  readonly kind: 'retry'
  readonly ms: number
}

/** A dispatched event: its `data` payload, plus the `event:` name (`'message'`
 * when the server sent an unnamed event, which is all ours are). */
export interface SseMessageFrame {
  readonly kind: 'message'
  readonly event: string
  readonly data: string
}

export type SseFrame = SseRetryFrame | SseMessageFrame

/** The event type a frame with no `event:` field dispatches as, per the spec. */
export const DEFAULT_EVENT_TYPE = 'message'

const LINE_END = /\r\n|\n|\r/

interface Block {
  data: string
  event: string
  retry: number | undefined
}

function emptyBlock(): Block {
  return { data: '', event: '', retry: undefined }
}

/**
 * Decode one line into the block being accumulated.
 *
 * A line is a comment (dropped), a field with a value, or a bare field name
 * (value `''`). Exactly one optional space after the colon is stripped, so
 * `data: x` and `data:x` both carry `x`.
 */
function applyLine(block: Block, line: string): void {
  if (line.startsWith(':')) return // keepalive / comment

  const colon = line.indexOf(':')
  const field = colon === -1 ? line : line.slice(0, colon)
  let value = colon === -1 ? '' : line.slice(colon + 1)
  if (value.startsWith(' ')) value = value.slice(1)

  switch (field) {
    case 'data':
      // The spec appends value + U+000A; the trailing newline comes off at
      // dispatch, which is what joins multi-line data with a single '\n'. That
      // mandatory newline is also why an empty `data` buffer is exactly "no
      // `data:` line was seen" — see `dispatch`.
      block.data += value + '\n'
      break
    case 'event':
      block.event = value
      break
    case 'retry':
      // Non-digits are ignored rather than coerced: `retry: soon` must not
      // become `NaN` and poison the reconnect delay.
      if (/^\d+$/.test(value)) block.retry = Number(value)
      break
    default:
      // `id:` and anything a newer server invents are ignored, per the spec.
      break
  }
}

/** The frames a completed block dispatches, in wire order. */
function* dispatch(block: Block): Generator<SseFrame> {
  if (block.retry !== undefined) yield { kind: 'retry', ms: block.retry }
  // A block with no `data:` at all (a lone `retry:`, or a block of comments)
  // dispatches no event — that is the spec ("If the data buffer is an empty
  // string, set the data buffer and the event type buffer to the empty string
  // and return"), and it is why `: ping` is invisible to the caller instead of
  // arriving as an empty message. A bare `data:` is NOT this case: it appends
  // its mandatory newline, so the buffer is `'\n'` and the empty message it
  // means is dispatched.
  if (block.data === '') return
  yield {
    kind: 'message',
    event: block.event === '' ? DEFAULT_EVENT_TYPE : block.event,
    data: block.data.endsWith('\n') ? block.data.slice(0, -1) : block.data,
  }
}

/**
 * Split `buffer` into the complete lines available and whatever is left over.
 *
 * The subtlety: a `\r` at the very end of the buffer may be the first half of a
 * `\r\n` whose second half is in the next chunk, so it is held back rather than
 * treated as a terminator. Without that, a chunk boundary between `\r` and `\n`
 * manufactures a spurious blank line and dispatches half a frame.
 */
function takeLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = []
  let rest = buffer
  for (;;) {
    const match = LINE_END.exec(rest)
    if (match === null) return { lines, rest }
    const at = match.index
    if (rest[at] === '\r' && at === rest.length - 1) return { lines, rest }
    lines.push(rest.slice(0, at))
    rest = rest.slice(at + match[0].length)
  }
}

/**
 * Read `stream` as an event stream, yielding one frame per dispatched block.
 *
 * A trailing partial block (bytes not terminated by a blank line when the
 * stream ends) is discarded, never emitted — a truncated frame is not an event.
 *
 * The caller owns the connection: this releases its reader lock on exit but
 * does not cancel the stream, so aborting stays the job of whatever
 * `AbortController` opened the request.
 */
export async function* readSseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader()
  // Streaming decode: a multi-byte character split across two chunks is held
  // until it is complete rather than emitted as U+FFFD.
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let block = emptyBlock()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })

      const { lines, rest } = takeLines(buffer)
      buffer = rest
      for (const line of lines) {
        if (line === '') {
          yield* dispatch(block)
          block = emptyBlock()
        } else {
          applyLine(block, line)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
