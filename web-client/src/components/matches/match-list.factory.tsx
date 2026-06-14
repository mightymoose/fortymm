/**
 * `MatchList` takes no props (it is the page orchestrator that owns its own URL
 * state and BFF query), so there is no `buildMatchListProps`. Its tests drive
 * it through the MSW endpoints instead.
 *
 * The default scenario is "the matches page with the default seeded list" — the
 * page object renders with no `server.use(...)` override, so the standard
 * `/v1/matches` + `/v1/session` handlers in `src/mocks/handlers.ts` answer
 * (rita.kovac on side 1 vs nguyen.t / silva.r / patel.m). Tests that want a
 * specific list pass these builders to `matchListPage.mockEndpoint(...)`.
 *
 * Re-exported from the shared payload factories so the page object and tests
 * import the wire builders from one place.
 */
export {
  matchListResponse,
  matchListRow,
  sessionResponse,
} from '@/test/factories'
