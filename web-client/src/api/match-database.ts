import * as z from 'zod'
import { api, bodyOf } from './client.ts'
import { fromWire, type Wire } from './wire.ts'

// POST /v1/match-database/apply (temporary in the api): apply parcels to a
// database sent with the request, and get the new database back.

export type RecordAnswer = {
  recordId: string
  answer: 'held' | 'malformed' | 'not_stored'
  reason: 'bad_signature' | 'match_records_only' | null
}

export type ParcelOutcome = {
  status: 'applied' | 'refused'
  reason: 'too_long' | 'damaged' | 'wrong_environment' | null
  records: RecordAnswer[]
}

export type ApplyAnswer =
  // The new database, as JSON text to show and to send back unchanged. It is
  // the api's own document on purpose: the person reads it and carries it
  // into the next submit, so it keeps the wire's keys and date strings.
  | { kind: 'applied'; databaseText: string; parcels: ParcelOutcome[] }
  // The api refused the request; `pointer` says where in it.
  | { kind: 'invalid'; pointer: string }
  // The database typed is not JSON, so nothing was sent.
  | { kind: 'not-json' }
  | { kind: 'unknown' }

const storedRecord = z.object({
  arrival: z.number(),
  arrived_at: z.string(),
  answer: z.literal('held'),
  record: z.string(),
})

const match = z.object({
  match_id: z.string(),
  sides: z.tuple([z.array(z.string()), z.array(z.string())]),
  terms: z.string(),
  created_by: z.string(),
})

const database = fromWire('MatchDatabase')(
  z.object({ records: z.array(storedRecord), matches: z.array(match) }),
)

const parcelOutcome = fromWire('ParcelOutcome')(
  z
    .object({
      status: z.enum(['applied', 'refused']),
      reason: z.enum(['too_long', 'damaged', 'wrong_environment']).nullable(),
      records: z.array(
        z.object({
          record_id: z.string(),
          answer: z.enum(['held', 'malformed', 'not_stored']),
          reason: z.enum(['bad_signature', 'match_records_only']).nullable(),
        }),
      ),
    })
    .transform(
      ({ status, reason, records }): ParcelOutcome => ({
        status,
        reason,
        records: records.map((r) => ({
          recordId: r.record_id,
          answer: r.answer,
          reason: r.reason,
        })),
      }),
    ),
)

export const matchDatabaseDocument = fromWire('MatchDatabaseDocument')(
  z
    .object({
      data: z.object({
        type: z.literal('match-database'),
        id: z.literal('new'),
        attributes: z.object({
          database,
          parcels: z.array(parcelOutcome),
        }),
      }),
    })
    .transform(
      ({ data }): ApplyAnswer => ({
        kind: 'applied',
        databaseText: JSON.stringify(data.attributes.database, null, 2),
        parcels: data.attributes.parcels,
      }),
    ),
)

export const invalidRequestErrorDocument = fromWire(
  'InvalidRequestErrorDocument',
)(
  z
    .object({
      errors: z
        .array(
          z.object({
            status: z.literal('422'),
            code: z.literal('invalid_request'),
            title: z.literal('The request is not valid'),
            source: z.object({ pointer: z.string() }),
          }),
        )
        .min(1),
    })
    .transform(
      ({ errors }): ApplyAnswer => ({
        kind: 'invalid',
        pointer: errors[0].source.pointer,
      }),
    ),
)

const answer = z.union([matchDatabaseDocument, invalidRequestErrorDocument])

// Apply `parcels`, in order, to the database in `databaseText`, as arriving
// at `arrivedAt`. Never throws.
export async function applyParcels({
  databaseText,
  parcels,
  arrivedAt,
}: {
  databaseText: string
  parcels: string[]
  arrivedAt: Date
}): Promise<ApplyAnswer> {
  let database: unknown
  try {
    database = JSON.parse(databaseText)
  } catch {
    return { kind: 'not-json' }
  }
  try {
    const response = await api.POST('/v1/match-database/apply', {
      // Sent as typed: the api decides whether it is a database.
      body: {
        database: database as Wire<'MatchDatabase'>,
        parcels,
        arrived_at: arrivedAt.toISOString(),
      },
    })
    const parsed = answer.safeParse(bodyOf(response))
    return parsed.success ? parsed.data : { kind: 'unknown' }
  } catch {
    return { kind: 'unknown' }
  }
}
