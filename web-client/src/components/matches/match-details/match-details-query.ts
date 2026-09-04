import { api, unwrap } from "@/api/client";
import type { MatchDetails } from "@/api/matches";
import type { Query, QueryFunctionContext } from "@tanstack/react-query";
import z from "zod";

const scoreboardSchema = z.object({
  status: z.enum(["scheduled", "live", "final"]),
});

const matchDetailsDataSchema = z.object({
  scoreboard: scoreboardSchema,
});

/** Tournament/fixture context for a match born from a draw — mirrors
 * `MatchTournamentContext` (api/app/schemas/match.py). Absent/null for a
 * casual match, or when the viewer must not see this tournament yet (an
 * unannounced draft is owner-only). */
const matchTournamentContextSchema = z.object({
  tournament_id: z.string(),
  tournament_name: z.string(),
  tournament_status: z.enum(["draft", "published", "live", "archived"]),
  event_id: z.string(),
  event_name: z.string(),
  table_label: z.string().nullable(),
  can_edit: z.boolean(),
});

/** Why `not_scorable_reason` is non-null — mirrors `MatchNotScorableReason`
 * (api/app/match_serialization.py). Perspective-neutral: computed from the
 * match alone, independent of `can_score` (which additionally requires the
 * viewer to be a participant). */
const matchNotScorableReasonSchema = z.enum([
  "no_opponent",
  "result_posted",
  "not_called",
  "not_scorable",
]);

const matchDetailsSchema = z.object({
  data: matchDetailsDataSchema,
  // The wire field is `tournament?: X | null` (optional AND nullable) — fold
  // "absent" into "null" so every downstream selector holds one total value
  // instead of juggling `undefined` and `null` as two spellings of "no
  // tournament" (#1288).
  tournament: matchTournamentContextSchema
    .nullish()
    .transform((value) => value ?? null),
  not_scorable_reason: matchNotScorableReasonSchema.nullable(),
});

export type MatchTournamentContext = z.infer<
  typeof matchTournamentContextSchema
>;
export type MatchNotScorableReason = z.infer<
  typeof matchNotScorableReasonSchema
>;

/** The fields every `matchDetailsQueryKey(matchId)` shares — exported so a
 * caller that needs to invalidate EVERY open match's details cache (not just
 * one) can do so without re-spelling the object literal. TanStack Query's
 * default (non-exact) key matching treats an object element as a SUBSET match
 * — a query whose key's object carries every field this one does (plus
 * `matchId`) still matches — so this prefix, with no `matchId`, matches every
 * match. Used by the realtime invalidation table
 * (`api/realtime/invalidation.ts`): a pushed hint doesn't name which match
 * changed, so it invalidates every match-details query this prefix matches. */
export const MATCH_DETAILS_QUERY_KEY_PREFIX = [
  { scope: "matches", version: "v1", entity: "details" },
] as const;

const queryKey = (matchId: string) =>
  [{ ...MATCH_DETAILS_QUERY_KEY_PREFIX[0], matchId }] as const;

/** The cache key the scoreboard (`scoreboardQuery` → `matchDetailsQuery`)
 * reads from. Mutations that change a match must invalidate this — it is a
 * different key from `matchQueryKey` in `@/api/matches`, which backs
 * `useMatch`, so updating one does not refresh the other. */
export const matchDetailsQueryKey = queryKey;

type MatchDetailsQueryKey = ReturnType<typeof queryKey>;

const fetchMatchDetails = async ({
  queryKey,
}: QueryFunctionContext<MatchDetailsQueryKey>) => {
  const [{ matchId }] = queryKey;
  const result = await api.GET("/v1/matches/{match_id}", {
    params: { path: { match_id: matchId } },
  });

  const data = unwrap(`load match ${matchId}`, result);

  return matchDetailsResultFromPayload(data);
};

/** Build the cache value `matchDetailsQuery` resolves to from a full
 * `MatchDetails` payload the caller already holds. Used by the queryFn (from the
 * GET response) and to seed the details cache from the `POST /v1/matches`
 * response before navigating to a just-created match (#510). Runs the parse, so
 * a malformed payload fails loudly rather than priming a bad cache entry. */
export function matchDetailsResultFromPayload(payload: MatchDetails) {
  return { ...matchDetailsSchema.parse(payload), unmigrated: payload };
}

/** The resolved shape `matchDetailsQuery`'s `queryFn` returns. */
export type MatchDetailsResult = ReturnType<
  typeof matchDetailsResultFromPayload
>;

/** The server's lifecycle label for a posted-but-unaccepted result (mirrors
 * `_status_label` in api/app/matches.py). While a match sits here it is waiting
 * on the *other* side to accept — a transition that happens in a different
 * browser session and so triggers no cache invalidation on this page. */
const AWAITING_ACCEPTANCE = "Awaiting acceptance";

/** How often (ms) to re-poll `GET /v1/matches/{id}` while a result is awaiting
 * the opponent's acceptance. */
const AWAITING_ACCEPTANCE_POLL_MS = 5_000;

/** Poll only while the match is awaiting the opponent's acceptance, and stop
 * once it leaves that state (accepted → Final).
 *
 * The proposer posts a result, then leaves the match page open; the opponent
 * accepts in their own session. Nothing invalidates the proposer's cache, and
 * the global client disables `refetchOnWindowFocus` with a 30s `staleTime`, so
 * without this the page is stuck on "Awaiting acceptance" until a manual
 * reload (#493). Returning `false` outside that state means a settled match
 * isn't polled, so the open page goes quiet again once it resolves.
 *
 * Exception: never poll while it's the viewer's *own* turn to act
 * (`negotiation.your_turn` — the `review`/`corrected` states). A silent poll
 * there swaps the standing result out from under the reviewer, so their
 * still-rendered Accept finalizes a correction they never re-reviewed (#726).
 * Freezing the rendered result means accepting a now-superseded one 409s, and
 * the callout surfaces that as a "reload to re-review" prompt. Spectators and
 * the waiting proposer have `your_turn=false`, so they keep polling.
 *
 * The tournament's director reviewing a match they don't play in also holds
 * `your_turn` (#1523), so they freeze too — deliberately. The #726 hazard is
 * about the reviewer's rendered result going stale under an Accept they're
 * about to press, and that is exactly as true of a director's Accept as of a
 * player's. This predicate reads the flag, not the viewer's side, so it needed
 * no change to cover them. */
export function refetchWhileAwaitingAcceptance(
  query: Pick<Query<MatchDetailsResult>, "state">,
): number | false {
  const data = query.state.data?.unmigrated;
  if (data?.status_label !== AWAITING_ACCEPTANCE) return false;
  if (data.negotiation.your_turn) return false;
  return AWAITING_ACCEPTANCE_POLL_MS;
}

/** Poll while the match page is showing a participant the "waiting to be
 * called" banner (#1288) — the tournament director calls the fixture in a
 * different browser session, so nothing else invalidates this cache, exactly
 * like `refetchWhileAwaitingAcceptance` above. `not_scorable_reason` is read
 * off the parsed slice (point 1's Zod schema); participation still has to
 * come from `unmigrated.sides`, which isn't parsed.
 *
 * Spectators never see the banner (a spectator on an already-callable match
 * has `not_scorable_reason: null`, not `'not_called'` — see the scorable/
 * spectator distinction in web-client/CLAUDE.md) and so never poll here.
 *
 * Also stops once the tournament is `archived`: an archived tournament has
 * already concluded, so a fixture still `not_called` there will never be
 * called — polling forever for a call that can't come would burn a request
 * every 5s on an open tab with nothing left to wait for. */
export function refetchWhileAwaitingCall(
  query: Pick<Query<MatchDetailsResult>, "state">,
): number | false {
  const result = query.state.data;
  if (result?.not_scorable_reason !== "not_called") return false;
  if (result.tournament?.tournament_status === "archived") return false;
  const isParticipant = result.unmigrated.sides.some(
    (side) => side.is_current_user_side,
  );
  return isParticipant ? AWAITING_ACCEPTANCE_POLL_MS : false;
}

/** The match-details poll predicate: either wait-for-acceptance or
 * wait-for-call keeps the page refreshing; neither means it goes quiet. */
export function matchDetailsRefetchInterval(
  query: Pick<Query<MatchDetailsResult>, "state">,
): number | false {
  return (
    refetchWhileAwaitingAcceptance(query) || refetchWhileAwaitingCall(query)
  );
}

export const matchDetailsQuery = (matchId: string) => ({
  queryKey: queryKey(matchId),
  queryFn: fetchMatchDetails,
  // Throw only when there is no cached data to fall back on. An initial-load
  // failure surfaces to the boundary for a retry; a background refetch
  // failure over already-rendered data must not — see the "`throwOnError`
  // also throws on a background refetch" section of web-client/CLAUDE.md
  // (#843's fix in `matchQueryOptions`, applied here for the same reason).
  throwOnError: (
    _error: unknown,
    query: Pick<Query<MatchDetailsResult>, "state">,
  ) => query.state.data === undefined,
  refetchInterval: matchDetailsRefetchInterval,
});
