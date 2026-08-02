import { ApiError } from '@/api/client'

import { addTable, keepTable, keepTables, tableInUseRefusal } from './table-catalogue'
import { buildTable, buildTables } from './seed.factory'

describe('keepTable / keepTables', () => {
  it('cites a table the server sent back', () => {
    const table = buildTable({ id: 't1', label: 'T1', court: 'A' })

    expect(keepTable(table)).toEqual({ kind: 'kept', table })
  })

  it('cites every stored table — the change-nothing catalogue', () => {
    const tables = buildTables(3)

    expect(keepTables(tables)).toEqual(tables.map((table) => ({ kind: 'kept', table })))
  })
})

describe('addTable', () => {
  // The whole point of the tagged union: a new entry has no `id` FIELD, so there is
  // no way to put a client-minted one on the wire (ADR 20260801 — the server mints
  // table ids, and `TournamentTableWrite` is `extra="forbid"`).
  it('carries the words and NO id', () => {
    const entry = addTable('T9', 'A')

    expect(entry).toEqual({ kind: 'added', label: 'T9', court: 'A' })
    expect('id' in entry).toBe(false)
  })
})

/** A refusal as `unwrap` builds it: the status, the extracted human `detail`, and
 * the raw body it came from. */
const refusal = (status: number, detail: unknown) =>
  new ApiError(
    status,
    typeof detail === 'string' ? detail : null,
    'update the tables',
    { detail },
  )

const IN_USE =
  '“T1” has 1 match placed at it, so removing it from the catalogue would leave ' +
  'those matches with no table — indistinguishable from matches nobody ever placed. ' +
  'To remove it anyway, send the same edit again with ' +
  '“unplace_fixtures_on_removed_tables”: true, and those matches lose their table, ' +
  'their time and their call and go back to the schedule to be placed again. To keep ' +
  'them where they are, leave the table in the catalogue and move the matches off it ' +
  'first.'

describe('tableInUseRefusal', () => {
  // Rendered VERBATIM — the ADR-0968 fallback. It names the tables by label and
  // counts the matches, neither of which the client can reconstruct.
  it('returns the 409’s sentence, untouched', () => {
    expect(tableInUseRefusal(refusal(409, IN_USE))).toBe(IN_USE)
  })

  // The narrowing that matters most. `saveFailure`'s `refused` arm is broader than
  // this refusal: a 403 lands in it too, and answering THAT with a confirm would ask
  // the director to authorise their own lockout — and re-send a destructive opt-in
  // against a request that will refuse identically.
  it('declines a 403, however sentence-shaped its detail', () => {
    expect(
      tableInUseRefusal(
        refusal(403, 'You can only modify tournaments you created.'),
      ),
    ).toBeNull()
  })

  // A 422 is Pydantic's array — machine prose, never shown (see `save-failure.ts`).
  it('declines a 422', () => {
    expect(
      tableInUseRefusal(
        refusal(422, [
          { type: 'value_error', loc: ['body', 'table_catalogue', 0, 'id'], msg: 'nope' },
        ]),
      ),
    ).toBeNull()
  })

  // The whole content of the confirm IS the server's prose. With nothing readable
  // there is no question to ask, so it takes the ordinary failure path instead of
  // opening an empty dialog.
  it('declines a 409 with no readable detail', () => {
    expect(tableInUseRefusal(refusal(409, null))).toBeNull()
  })

  it('declines anything that is not an ApiError', () => {
    expect(tableInUseRefusal(new TypeError('Failed to fetch'))).toBeNull()
    expect(tableInUseRefusal(undefined)).toBeNull()
  })
})
