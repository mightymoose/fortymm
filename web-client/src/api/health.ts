import * as z from 'zod'
import { api, bodyOf } from './client.ts'
import { fromWire } from './wire.ts'

// What the web client knows about the api's health: one of three answers.
// `unknown` covers every case where the api did not tell us either of the
// other two: it could not be reached, or its answer is neither document.
export type Health =
  | { status: 'healthy' }
  | { status: 'database-unavailable' }
  | { status: 'unknown' }

// The two answers GET /v1/health documents, wire shape in, Health out. Their
// input is bound to the api's document by fromWire (see wire.ts).
export const healthDocument = fromWire('HealthDocument')(
  z
    .object({
      data: z.object({
        type: z.literal('health'),
        id: z.literal('api'),
        attributes: z.object({ database: z.literal('ok') }),
      }),
    })
    .transform((): Health => ({ status: 'healthy' })),
)

export const databaseUnavailableErrorDocument = fromWire(
  'DatabaseUnavailableErrorDocument',
)(
  z
    .object({
      errors: z
        .array(
          z.object({
            status: z.literal('503'),
            code: z.literal('database_unavailable'),
            title: z.literal('The database did not answer'),
          }),
        )
        .min(1),
    })
    .transform((): Health => ({ status: 'database-unavailable' })),
)

// Every answer that means something, as one sum type. A plain union: the two
// bodies share no key to discriminate on (one has `data`, the other `errors`).
// The 500 the document also declares is left out on purpose: it means
// "unknown", like any body that matches no variant.
const answer = z.union([healthDocument, databaseUnavailableErrorDocument])

// GET /v1/health, turned into a Health. Never throws. The body alone decides
// the answer, by which schema it matches; nothing is read from it before.
export async function fetchHealth(): Promise<Health> {
  try {
    const parsed = answer.safeParse(bodyOf(await api.GET('/v1/health')))
    return parsed.success ? parsed.data : { status: 'unknown' }
  } catch {
    // A network error, or a body that isn't JSON (openapi-fetch parses it).
    return { status: 'unknown' }
  }
}
