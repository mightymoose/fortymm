// Type-level tests, checked by `tsc -b` (web-client:typecheck). Nothing here
// runs or ships: no module imports this file.
//
// They prove the client and the component-test mocks are typed from the
// api's OpenAPI document (src/api/schema.gen.ts). Each marked line must be a
// type error; if the typing were lost (an untyped client, MSW's plain `http`),
// the expect-error directive would be unused and tsc would fail.
import { http } from '../test/api/server.ts'
import { api } from './client.ts'

export async function callsWhatTheDocumentDeclares() {
  const { data, error } = await api.GET('/v1/health')
  const database: 'ok' | undefined = data?.data.attributes.database
  const code: 'database_unavailable' | 'internal_server_error' | undefined =
    error?.errors[0]?.code
  return { database, code }
}

export async function callsWhatTheDocumentDoesNotDeclare() {
  // @ts-expect-error: the document has no /v1/no-such-path
  await api.GET('/v1/no-such-path')
  // @ts-expect-error: the document has no POST /v1/health
  await api.POST('/v1/health')

  const { data } = await api.GET('/v1/health')
  // @ts-expect-error: HealthAttributes has no field `status`
  return data?.data.attributes.status
}

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
