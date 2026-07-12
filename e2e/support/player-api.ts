import type { Guest } from './match-api'

// Composed-stack helpers for reading the **player profile bundle**
// (`GET /v1/players/{id}`) directly over the real API, the way the page's cards
// do. A spec uses these to learn a fact it needs *before* it opens the browser —
// principally the id of the league the profile is bound to, which is minted per
// stack and so cannot be hardcoded.
//
// Read-only: no CSRF header, no cookies beyond the guest's own session (the
// bundle is authed — it carries a viewer-aware head-to-head block).

const API = '/api/v1'

/** One row of the profile's Leagues card, as the API sends it. */
export interface ProfileLeague {
  readonly id: string
  readonly name: string
  readonly is_default: boolean
  readonly rating: number | null
}

/**
 * The leagues a player belongs to, as `viewer` sees them on the profile bundle.
 *
 * **Today this is always exactly one row: the default league.** Nothing in the
 * API creates a league or a membership except `add_user_to_default_league`, which
 * runs once when a user is minted — there is no join-a-league endpoint to call.
 * So a spec can read the default league's id here (to exercise the `?league=` URL
 * contract), but it cannot seed a *second* ladder to switch to. See the note at
 * the top of `tests/player-profile.spec.ts`.
 */
export async function fetchProfileLeagues(
  viewer: Guest,
  playerId: string,
): Promise<ProfileLeague[]> {
  const res = await viewer.ctx.get(`${API}/players/${playerId}`)
  if (!res.ok()) {
    throw new Error(`load profile failed: ${res.status()} ${await res.text()}`)
  }
  return ((await res.json()) as { leagues: ProfileLeague[] }).leagues
}

/** The player's default league — the ladder the profile falls back to when the
 * URL names none. Throws if the API somehow reports no default, which would mean
 * the stack was never seeded (`api/scripts/seed_leagues.py`). */
export async function fetchDefaultLeague(
  viewer: Guest,
  playerId: string,
): Promise<ProfileLeague> {
  const leagues = await fetchProfileLeagues(viewer, playerId)
  const fallback = leagues.find((league) => league.is_default)
  if (!fallback) {
    throw new Error(
      `player ${playerId} is in no default league — is the stack seeded?`,
    )
  }
  return fallback
}
