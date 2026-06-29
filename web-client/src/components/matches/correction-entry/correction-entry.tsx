import { useState } from "react";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { ApiError } from "@/api/client";
import {
  matchDetailRoute,
  useMatch,
  useProposeResult,
  type MatchDetails,
  type MatchResultsGameWrite,
} from "@/api/matches";
import { initialsOf } from "@/lib/utils";
import { ScorePad } from "../score-pad";
import {
  isAcceptableScoreInput,
  validateGameScore,
} from "../score-pad/validate-game-score";

// Placeholder identity for a player-less (solo) opponent side, mirroring the
// scratchpad entry screen so the correction board reads the same.
const NO_OPPONENT_LABEL = "No opponent";

type StandingGame = NonNullable<
  MatchDetails["negotiation"]["standing_result"]
>["games"][number];

/** One game's two raw input strings, keyed by `game_number`. The viewer always
 * reads the left field as *their* side, regardless of side number. */
interface GameDraft {
  gameNumber: number;
  me: string;
  opp: string;
}

/**
 * Seed the editable drafts from the immutable standing-result snapshot (NOT the
 * live scratchpad). The viewer's side reads left; the orientation is restored on
 * submit from `mySideNumber`.
 */
function seedDrafts(games: StandingGame[], mySideNumber: 1 | 2): GameDraft[] {
  return [...games]
    .sort((a, b) => a.game_number - b.game_number)
    .map((g) => ({
      gameNumber: g.game_number,
      me: String(mySideNumber === 1 ? g.side_1_points : g.side_2_points),
      opp: String(mySideNumber === 1 ? g.side_2_points : g.side_1_points),
    }));
}

/**
 * "Suggest a correction" screen. Pre-fills the score inputs from
 * `negotiation.standing_result.games` (the immutable proposal snapshot) and, on
 * submit, posts a counter-proposal that supersedes that standing result. A 409
 * (the proposal moved on) is surfaced inline; success navigates back to the
 * match-details page.
 */
export function CorrectionEntry({ matchId }: { matchId: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useMatch(matchId);
  const proposeMutation = useProposeResult(matchId);

  // `null` means "not seeded yet" — seeded once `data` arrives (below), so we
  // avoid a state-syncing effect on first render.
  const [drafts, setDrafts] = useState<GameDraft[] | null>(null);

  if (isLoading || !data) {
    return <div aria-busy="true" data-testid="correction-entry-loading" />;
  }

  const standing = data.negotiation.standing_result;
  const mySide = data.sides.find((s) => s.is_current_user_side) ?? null;
  const oppSide = data.sides.find((s) => !s.is_current_user_side) ?? null;

  // The correction flow only applies to participants with a standing result to
  // correct. Spectators, or a match with no proposal in play, bounce back.
  if (!standing || !mySide || !oppSide) {
    return <Navigate {...matchDetailRoute(matchId)} />;
  }

  // Captured here (rather than read inside `onSubmit`) so the standing-result
  // narrowing from the guard above survives into the submit closure.
  const standingId = standing.id;
  const mySideNumber: 1 | 2 = mySide.side_number === 2 ? 2 : 1;
  const meName = mySide.players[0]?.username ?? "You";
  const meInitials = initialsOf(meName);
  const oppUsername = oppSide.players[0]?.username ?? null;
  const oppName = oppUsername ?? NO_OPPONENT_LABEL;
  const oppHasPlayer = oppUsername !== null;

  const current = drafts ?? seedDrafts(standing.games, mySideNumber);

  const setGame = (gameNumber: number, next: Partial<GameDraft>) => {
    setDrafts(
      current.map((d) => (d.gameNumber === gameNumber ? { ...d, ...next } : d)),
    );
    if (proposeMutation.error) proposeMutation.reset();
  };

  // Per-game validation verdicts, indexed alongside `current`.
  const validations = current.map((d) => validateGameScore(d.me, d.opp));
  const allValid = validations.every((v) => v.valid);

  // A 409 means the standing result moved on (someone else proposed/accepted
  // since this screen loaded); a 422 means the board itself was rejected. Both
  // surface inline; everything else falls back to the API message.
  const apiError =
    proposeMutation.error instanceof ApiError ? proposeMutation.error : null;

  const inputsLocked = proposeMutation.isPending;

  function onSubmit() {
    if (!allValid || proposeMutation.isPending) return;
    const games: MatchResultsGameWrite[] = current.map((d) =>
      mySideNumber === 1
        ? {
            game_number: d.gameNumber,
            side_1_points: Number(d.me),
            side_2_points: Number(d.opp),
          }
        : {
            game_number: d.gameNumber,
            side_1_points: Number(d.opp),
            side_2_points: Number(d.me),
          },
    );
    proposeMutation.mutate(
      { games, supersedes_result_id: standingId },
      { onSuccess: () => navigate(matchDetailRoute(matchId)) },
    );
  }

  return (
    <div className="entry-wrap">
      <div className="entry-head">
        <h2>Suggest a correction.</h2>
        <div className="hint">
          Adjust the game(s) that look off, then send the corrected score to{" "}
          {oppName} to confirm.
        </div>
      </div>

      {apiError !== null && (
        <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
          {apiError.status === 409
            ? "This proposal has moved on — reload the match to see the latest score."
            : (apiError.detail ?? apiError.message)}
        </p>
      )}

      {current.map((d, i) => {
        const v = validations[i];
        return (
          <section key={d.gameNumber} className="correction-game">
            <h3 className="text-sm font-medium text-[color:var(--muted)]">
              Game {d.gameNumber}
            </h3>
            <ScorePad
              me={{
                name: meName,
                initials: meInitials,
                value: d.me,
                // Red-flag this field when its own value is malformed, or when a
                // pair-level rule violation (tie/deuce) makes neither side
                // individually malformed — but NOT when only the *other* side is
                // malformed (its error shouldn't bleed onto this clean input).
                invalid:
                  v.meMalformed ||
                  (v.error !== null && !v.meMalformed && !v.oppMalformed),
                onChange: (value) => {
                  if (!isAcceptableScoreInput(value)) return;
                  setGame(d.gameNumber, { me: value });
                },
              }}
              opp={{
                name: oppName,
                initials: oppHasPlayer ? initialsOf(oppName) : null,
                value: d.opp,
                invalid:
                  v.oppMalformed ||
                  (v.error !== null && !v.meMalformed && !v.oppMalformed),
                onChange: (value) => {
                  if (!isAcceptableScoreInput(value)) return;
                  setGame(d.gameNumber, { opp: value });
                },
              }}
              gamesTally={null}
              scoreError={v.error}
              showBothRequired={v.oneSideFilled && v.error === null}
              inputsLocked={inputsLocked}
              // The per-game pads are inputs-only (hideActions); a single shared
              // action row below the whole board owns the one submit.
              hideActions
            />
          </section>
        );
      })}

      <div className="single-actions">
        <div className="result-line subtle">
          {data.affects_rating
            ? "Sending the corrected score posts it for your opponent to confirm."
            : "Sending the corrected score finalizes the match immediately."}
        </div>
        <div className="action-btns">
          <button
            type="button"
            className="btn primary"
            disabled={!allValid || inputsLocked}
            onClick={onSubmit}
          >
            {proposeMutation.isPending ? "Sending…" : "Send corrected score"}
          </button>
        </div>
      </div>
    </div>
  );
}
