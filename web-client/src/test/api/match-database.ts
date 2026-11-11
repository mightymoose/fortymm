import { http } from './server.ts'

// How the api's POST /v1/match-database/apply can answer, for server.use(...)
// in a test. Each handler records the bodies it was sent in `requests`, so a
// test can check what the form sent.

type Request = { database: unknown; parcels: string[]; arrived_at: string }

export const NEW_DATABASE = {
  records: [
    {
      arrival: 1,
      arrived_at: '2026-11-11T12:00:00Z',
      answer: 'held' as const,
      record: 'aa',
    },
  ],
  matches: [
    {
      match_id: 'bb'.repeat(32),
      sides: [['11'.repeat(32)], ['22'.repeat(32)]] as [string[], string[]],
      terms: '',
      created_by: 'cc'.repeat(33),
    },
  ],
}

// 200: the parcels were applied. One answer per parcel sent: the first is
// applied with its record held, any others were refused as damaged.
export function applies() {
  const requests: Request[] = []
  const handler = http.post('/v1/match-database/apply', async ({ request, response }) => {
    const body = (await request.json()) as Request
    requests.push(body)
    return response(200).json({
      data: {
        type: 'match-database',
        id: 'new',
        attributes: {
          database: NEW_DATABASE,
          parcels: body.parcels.map((_, index) =>
            index === 0
              ? {
                  status: 'applied' as const,
                  reason: null,
                  records: [
                    { record_id: 'bb'.repeat(32), answer: 'held' as const, reason: null },
                  ],
                }
              : { status: 'refused' as const, reason: 'damaged' as const, records: [] },
          ),
        },
      },
    })
  })
  return { handler, requests }
}

// 422: the api refused the request, pointing at the database.
export function refusesTheDatabase() {
  const requests: Request[] = []
  const handler = http.post('/v1/match-database/apply', async ({ request, response }) => {
    requests.push((await request.json()) as Request)
    return response(422).json({
      errors: [
        {
          status: '422',
          code: 'invalid_request',
          title: 'The request is not valid',
          source: { pointer: '/database' },
        },
      ],
    })
  })
  return { handler, requests }
}
