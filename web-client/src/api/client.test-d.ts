// Type-level tests, checked by `tsc -b` (web-client:typecheck). Nothing here
// runs or ships: no module imports this file.
//
// They prove the client's requests, the zod schemas' input and the
// component-test mocks all follow the api's OpenAPI document. Each marked line
// must be a type error; if the typing were lost (an untyped client, a schema
// not bound by fromWire, MSW's plain `http`), the expect-error directive would
// be unused and tsc would fail.
import * as z from 'zod'
import { http } from '../test/api/server.ts'
import { api } from './client.ts'
import { type Health, healthDocument } from './health.ts'
import { fromWire, type Wire } from './wire.ts'

export async function callsWhatTheDocumentDeclares() {
  await api.GET('/v1/health')
}

export async function callsWhatTheDocumentDoesNotDeclare() {
  // @ts-expect-error: the document has no /v1/no-such-path
  await api.GET('/v1/no-such-path')
  // @ts-expect-error: the document has no POST /v1/health
  await api.POST('/v1/health')
}

// A schema's input is the wire shape; its output is the app's.
export const wireIn: Wire<'HealthDocument'> = {} as z.input<
  typeof healthDocument
>
export const appOut: Health = {} as z.output<typeof healthDocument>

// What a schema bound by fromWire may not do: describe a wire shape other
// than the document's, in either direction.
const attributes = (shape: z.ZodRawShape) =>
  z.object({
    data: z.object({
      type: z.literal('health'),
      id: z.literal('api'),
      attributes: z.object(shape),
    }),
  })
export const schemasThatDriftFromTheDocument = [
  // The document's own shape, transformed into anything: fine.
  fromWire('HealthAttributes')(
    z.object({ database: z.literal('ok') }).transform(() => ({ isOk: true })),
  ),
  // @ts-expect-error: a field renamed (`database` is `db` here)
  fromWire('HealthAttributes')(z.object({ db: z.literal('ok') })),
  fromWire('HealthAttributes')(
    // @ts-expect-error: a field the document doesn't have
    z.object({ database: z.literal('ok'), checkedAt: z.string() }),
  ),
  // @ts-expect-error: a field of the document left out
  fromWire('HealthAttributes')(z.object({})),
  // @ts-expect-error: a value the document doesn't allow ("down")
  fromWire('HealthAttributes')(z.object({ database: z.enum(['ok', 'down']) })),
  // @ts-expect-error: the same, one level down
  fromWire('HealthDocument')(attributes({ database: z.literal('down') })),
]

export const mocksWhatTheDocumentDeclares = http.get(
  '/v1/health',
  ({ response }) =>
    response(200).json({
      data: { type: 'health', id: 'api', attributes: { database: 'ok' } },
    }),
)

export const mocksWhatTheDocumentDoesNotDeclare = [
  // @ts-expect-error: the document has no /v1/no-such-path
  http.get('/v1/no-such-path', () => new Response()),
  http.get('/v1/health', ({ response }) =>
    response(200).json({
      // @ts-expect-error: `database` is the constant "ok", never "down"
      data: { type: 'health', id: 'api', attributes: { database: 'down' } },
    }),
  ),
  http.get('/v1/health', ({ response }) =>
    // @ts-expect-error: the document declares no 404 for GET /v1/health
    response(404).json({ errors: [] }),
  ),
  http.get('/v1/health', ({ response }) =>
    response(503).json({
      errors: [
        {
          status: '503',
          // @ts-expect-error: the 503's code is "database_unavailable"
          code: 'database_down',
          title: 'The database did not answer',
        },
      ],
    }),
  ),
]
