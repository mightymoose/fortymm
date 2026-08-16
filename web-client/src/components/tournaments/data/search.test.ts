import { tournamentsSearchSchema, type TournamentsSearch } from './search'
import type { TournamentStatus } from './types'

/** The URL is a boundary, and this is the parse. Its whole job is to be **total**:
 * whatever a stale bookmark or a hand-edited address bar carries, it produces a value
 * the page can render, and it never throws into the route. */
describe('tournamentsSearchSchema', () => {
  it('carries a status and a query through', () => {
    expect(tournamentsSearchSchema.parse({ status: 'live', q: 'Bay' })).toEqual({
      status: 'live',
      q: 'Bay',
    })
  })

  it('accepts every status the tabs offer', () => {
    const statuses: TournamentStatus[] = ['draft', 'published', 'live', 'archived']
    for (const status of statuses) {
      expect(tournamentsSearchSchema.parse({ status }).status).toBe(status)
    }
  })

  // A bookmark that predates a status rename must render the All tab, not a route
  // error — so an unrecognized value degrades to "no filter" rather than throwing.
  it('degrades an unrecognized status to no filter', () => {
    expect(tournamentsSearchSchema.parse({ status: 'someoldvalue' }).status).toBeUndefined()
    expect(tournamentsSearchSchema.parse({ status: 42 }).status).toBeUndefined()
  })

  it('collapses a whitespace-only query to no filter', () => {
    expect(tournamentsSearchSchema.parse({ q: '   ' }).q).toBeUndefined()
    expect(tournamentsSearchSchema.parse({ q: '' }).q).toBeUndefined()
  })

  it('trims a query it keeps', () => {
    expect(tournamentsSearchSchema.parse({ q: '  Bay  ' }).q).toBe('Bay')
  })

  it('never throws, whatever the URL carries', () => {
    expect(() =>
      tournamentsSearchSchema.parse({ status: null, q: [], extra: 'ignored' }),
    ).not.toThrow()
  })

  it('reads an empty search as both filters off', () => {
    expect(tournamentsSearchSchema.parse({})).toEqual({
      status: undefined,
      q: undefined,
    })
  })

  /** The point of reading `status` off the tab `Record`'s keys rather than hand-typing
   * `z.enum(['draft', …])`: if this widened to `string`, a fifth status would red the
   * tab strip and leave the URL schema quietly green — the exact split #970 exists to
   * close. Enforced by `tsc -b`, not by vitest. */
  it('types status as TournamentStatus, never a bare string', () => {
    expectTypeOf<TournamentsSearch['status']>().toEqualTypeOf<
      TournamentStatus | undefined
    >()
    expectTypeOf<TournamentsSearch['q']>().toEqualTypeOf<string | undefined>()
  })
})
