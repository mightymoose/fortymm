import { describe, expect, it } from 'vitest'

import { readSseFrames, type SseFrame } from './sse-frames'

// ----- harness ----------------------------------------------------------------
//
// Every case feeds the reader *bytes*, chunked where we say, because the whole
// point of this module is that a chunk boundary is not a frame boundary. A test
// that only ever hands it whole frames proves nothing a naive `split('\n')`
// wouldn't also pass.

const encoder = new TextEncoder()

function streamOf(...chunks: Array<Uint8Array | string>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

/** Split `text` into byte chunks at the given byte offsets. */
function bytesSplitAt(text: string, ...offsets: number[]): Uint8Array[] {
  const bytes = encoder.encode(text)
  const bounds = [0, ...offsets, bytes.length]
  return bounds
    .slice(0, -1)
    .map((start, i) => bytes.slice(start, bounds[i + 1]))
    .filter((chunk) => chunk.length > 0)
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  for await (const frame of readSseFrames(stream)) frames.push(frame)
  return frames
}

/** The shape the server actually sends, so the fixtures read like the wire. */
const hint = (kind: string) => `{"v":1,"kind":"${kind}","ts":"2026-07-25T00:26:37.607498Z"}`

const message = (data: string): SseFrame => ({ kind: 'message', event: 'message', data })

// ----- the happy wire ---------------------------------------------------------

describe('readSseFrames', () => {
  it('decodes the transcript the server actually sends', async () => {
    const frames = await collect(
      streamOf(
        `retry: 6458\n\ndata: ${hint('resync')}\n\ndata: ${hint('dashboard.changed')}\n\n: ping\n\n`,
      ),
    )

    expect(frames).toEqual([
      { kind: 'retry', ms: 6458 },
      message(hint('resync')),
      message(hint('dashboard.changed')),
    ])
  })

  // ----- chunk boundaries in the wrong places ---------------------------------

  it('reassembles a frame split mid-field-name across two chunks', async () => {
    // `dat` + `a: {...}` — a per-chunk split would decode a field called `dat`
    // and a field called `a`, and lose the payload entirely.
    const frames = await collect(streamOf('dat', `a: ${hint('resync')}\n\n`))

    expect(frames).toEqual([message(hint('resync'))])
  })

  it('reassembles a frame split mid-value across two chunks', async () => {
    const wire = `data: ${hint('dashboard.changed')}\n\n`
    // Land the boundary inside the JSON, between `"kind":"dash` and the rest.
    const cut = wire.indexOf('dash') + 4
    const frames = await collect(streamOf(...bytesSplitAt(wire, cut)))

    expect(frames).toEqual([message(hint('dashboard.changed'))])
  })

  it('reassembles a frame split immediately before its blank-line terminator', async () => {
    const wire = `data: ${hint('resync')}\n\n`
    const frames = await collect(streamOf(...bytesSplitAt(wire, wire.length - 1)))

    expect(frames).toEqual([message(hint('resync'))])
  })

  it('holds a CRLF split between the \\r and the \\n instead of dispatching early', async () => {
    // A reader that treats a trailing `\r` as a terminator sees the next chunk's
    // leading `\n` as a *blank line* and dispatches `a` on its own — two frames
    // where the server sent one.
    const wire = 'data: a\r\ndata: b\r\n\r\n'
    const frames = await collect(streamOf(...bytesSplitAt(wire, 'data: a\r'.length)))

    expect(frames).toEqual([message('a\nb')])
  })

  it('reassembles a multi-byte character split across two chunks', async () => {
    const wire = 'data: 🏓\n\n'
    // The paddle is 4 bytes; cut it in half.
    const cut = encoder.encode('data: ').length + 2
    const frames = await collect(streamOf(...bytesSplitAt(wire, cut)))

    expect(frames).toEqual([message('🏓')])
  })

  it('decodes a stream delivered one byte at a time', async () => {
    const wire = `retry: 6458\n\ndata: ${hint('resync')}\n\n`
    const bytes = encoder.encode(wire)
    const frames = await collect(streamOf(...[...bytes].map((b) => Uint8Array.of(b))))

    expect(frames).toEqual([{ kind: 'retry', ms: 6458 }, message(hint('resync'))])
  })

  // ----- lines that are not events --------------------------------------------

  it('drops keepalive comments rather than surfacing them as events', async () => {
    const frames = await collect(streamOf(': ping\n\n', ':\n\n', `data: ${hint('resync')}\n\n`))

    expect(frames).toEqual([message(hint('resync'))])
  })

  it('ignores fields it has no use for, including id', async () => {
    // `id:` is parsed and dropped on purpose: hints are idempotent, so a
    // reconnect refetches rather than replaying from a cursor.
    const frames = await collect(streamOf('id: 42\nfuture-field: x\ndata: a\n\n'))

    expect(frames).toEqual([message('a')])
  })

  // ----- field syntax ----------------------------------------------------------

  it('strips exactly one optional space after the colon', async () => {
    const frames = await collect(streamOf('data: x\n\ndata:x\n\ndata:  x\n\n'))

    expect(frames).toEqual([message('x'), message('x'), message(' x')])
  })

  it('joins multi-line data with a newline', async () => {
    const frames = await collect(streamOf('data: one\ndata: two\ndata: three\n\n'))

    expect(frames).toEqual([message('one\ntwo\nthree')])
  })

  it('keeps an empty data line as an empty line, not as nothing', async () => {
    const frames = await collect(streamOf('data: one\ndata:\ndata: three\n\n'))

    expect(frames).toEqual([message('one\n\nthree')])
  })

  it('dispatches an empty message for a block whose only line is a bare data:', async () => {
    // The boundary between "no `data:` line at all" (dispatch nothing) and "a
    // `data:` line carrying nothing" (dispatch an empty message). The first is
    // an empty data buffer; the second is `'\n'`, because every `data:` appends
    // its newline. `: ping\n\n` above is the other side of the same line.
    const frames = await collect(streamOf('data:\n\n'))

    expect(frames).toEqual([message('')])
  })

  it('reads a lone \\r as a line terminator', async () => {
    const frames = await collect(streamOf('data: a\rdata: b\n\n'))

    expect(frames).toEqual([message('a\nb')])
  })

  it('surfaces a named event, and defaults an unnamed one to message', async () => {
    const frames = await collect(streamOf('event: named\ndata: a\n\ndata: b\n\n'))

    expect(frames).toEqual([{ kind: 'message', event: 'named', data: 'a' }, message('b')])
  })

  // ----- retry ------------------------------------------------------------------

  it('surfaces a retry directive as its own frame', async () => {
    const frames = await collect(streamOf('retry: 6458\n\n'))

    expect(frames).toEqual([{ kind: 'retry', ms: 6458 }])
  })

  it('emits a retry carried alongside data before the event it rode in on', async () => {
    const frames = await collect(streamOf('retry: 3000\ndata: a\n\n'))

    expect(frames).toEqual([{ kind: 'retry', ms: 3000 }, message('a')])
  })

  it('ignores a non-numeric retry rather than reconnecting after NaN ms', async () => {
    const frames = await collect(streamOf('retry: soon\ndata: a\n\n'))

    expect(frames).toEqual([message('a')])
  })

  // ----- truncation ---------------------------------------------------------------

  it('discards a trailing partial frame at end of stream', async () => {
    const truncated = `data: ${hint('dashboard.changed')}`.slice(0, 30)
    const frames = await collect(streamOf(`data: ${hint('resync')}\n\n`, truncated))

    expect(frames).toEqual([message(hint('resync'))])
  })

  it('discards a complete frame that never got its blank line', async () => {
    const frames = await collect(streamOf(`data: ${hint('resync')}\n`))

    expect(frames).toEqual([])
  })

  it('yields nothing for an empty stream', async () => {
    expect(await collect(streamOf())).toEqual([])
  })

  // ----- streaming, not buffer-then-parse -------------------------------------

  it('yields a frame before the stream closes', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })

    const frames = readSseFrames(stream)
    controller.enqueue(encoder.encode(`data: ${hint('resync')}\n\n`))
    // If the reader drained to EOF before parsing, this would never settle.
    await expect(frames.next()).resolves.toEqual({
      done: false,
      value: message(hint('resync')),
    })

    controller.close()
    await expect(frames.next()).resolves.toEqual({ done: true, value: undefined })
  })
})
