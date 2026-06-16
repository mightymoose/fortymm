// Match ids are UUIDs. A malformed id (e.g. /matches/not-a-uuid) would 422 on
// every self-fetching section and surface an `ApiError` in the console even
// though the UI handles it (#494). Guarding the param shape client-side means
// we never make the request: no 422, no console error — just the friendly
// not-found state the boundary already renders for a 404/422.
//
// Shared by every route keyed on a match id (match details + the scoring
// screens) so they all reject a malformed id the same way (#385) rather than
// each duplicating the regex.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether `matchId` is shaped like the UUID the API expects. */
export function isMatchId(matchId: string): boolean {
  return UUID_RE.test(matchId)
}
