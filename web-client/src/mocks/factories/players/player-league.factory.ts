import type { components } from '@/api/schema'

type PlayerLeague = components['schemas']['PlayerLeague']

/**
 * League ids are **uuids on the wire**, and the profile route's `?league=`
 * search schema validates them as such (`z.string().uuid()`) — because the API's
 * `league_id` query param is a `uuid.UUID`, so FastAPI 422s on anything else and
 * the client must never send one.
 *
 * That makes these constants load-bearing rather than decorative: a fixture with
 * a `'usatt'`-style id would be *caught* by that schema and silently degrade to
 * the default league, and a switcher test written on it would pass without ever
 * having switched anything.
 */
export const FORTYMM_LEAGUE_ID = '2f9b6b1c-0d3a-4f26-9d5e-3b1c8a7e4d20'
export const USATT_LEAGUE_ID = '8c4e1a77-5b62-4a90-bb31-6e0f2d9c1a58'

/** A league the player belongs to, and the rating they carry **on it** — one row
 * of the Leagues card, which is also the profile's league switcher (ADR-0915). */
export function buildPlayerLeague(
  overrides: Partial<PlayerLeague> = {},
): PlayerLeague {
  return {
    id: FORTYMM_LEAGUE_ID,
    name: 'FortyMM',
    is_default: true,
    rating: 1687,
    ...overrides,
  }
}

/**
 * The **default** league — the one every player is joined to on sign-up, and the
 * one the page falls back to when the URL names none (`CONTEXT.md` § *Default
 * league*). Its rating is the one the default `buildPlayerDetail` reports at the
 * top level (1687): the card's row and the hero are two views of the same fact
 * on the same ladder, and a fixture that lets them disagree is lying.
 */
export const buildDefaultLeague = buildPlayerLeague

/**
 * A **second** league — the row that makes the switcher exercisable at all.
 *
 * Its rating (1642) is deliberately *different* from the default league's:
 * "a player rated 1687 in FortyMM and 1642 in USATT has no single rating to
 * show" is the whole reason ADR-0915 exists. A fixture whose two leagues carry
 * the same rating would let a broken switcher — one that never rebinds the
 * rating half of the page — pass its tests.
 */
export function buildSecondLeague(
  overrides: Partial<PlayerLeague> = {},
): PlayerLeague {
  return buildPlayerLeague({
    id: USATT_LEAGUE_ID,
    name: 'USATT',
    is_default: false,
    rating: 1642,
    ...overrides,
  })
}

/**
 * A league the player belongs to but holds **no rating** in — a membership on a
 * ladder they have never been rated on (the API outer-joins the rating, so the
 * league still appears with a `null`). The card prints an em dash, not a zero.
 */
export function buildUnratedLeague(
  overrides: Partial<PlayerLeague> = {},
): PlayerLeague {
  return buildSecondLeague({ rating: null, ...overrides })
}
