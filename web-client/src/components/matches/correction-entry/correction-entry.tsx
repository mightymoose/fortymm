import { useRef, useState } from "react";
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
import { firstMatchScoreError } from "@/lib/scoring";
import { ScorePad } from "../score-pad";
import {
  isAcceptableScoreInput,
  validateGameScore,
} from "../score-pad/validate-game-score";
import { CorrectionScoreline } from "./correction-scoreline";

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
 * Seed one editable draft per `best_of` slot from the immutable standing-result
 * snapshot (NOT the live scratchpad): played games pre-fill, the remaining
 * slots start empty so the corrector can add games to reach a decided board
 * (a 3–0 flipped to 2–1 needs a game 4/5 to finish). The viewer's side reads
 * left; the orientation is restored on submit from `mySideNumber`.
 */
function seedDrafts(
  games: StandingGame[],
  mySideNumber: 1 | 2,
  bestOf: number,
): GameDraft[] {
  const byNumber = new Map(games.map((g) => [g.game_number, g]));
  return Array.from({ length: bestOf }, (_, i) => {
    const gameNumber = i + 1;
    const g = byNumber.get(gameNumber);
    if (!g) return { gameNumber, me: "", opp: "" };
    return {
      gameNumber,
      me: String(mySideNumber === 1 ? g.side_1_points : g.side_2_points),
      opp: String(mySideNumber === 1 ? g.side_2_points : g.side_1_points),
    };
  });
}

/**
 * "Suggest a correction" screen — a full board re-score, seeded from the
 * standing result. Unlike a per-game scratchpad edit, correcting a winner can
 * leave the match undecided (3–0 → 2–1), so the corrector edits one game at a
 * time in a single `ScorePad` and navigates the board via the SCORELINE strip,
 * adding/removing games until the buffered board is a decided match. On submit
 * it posts a counter-proposal that supersedes the standing result; a 409 (the
 * proposal moved on) or 422 (board rejected) surfaces inline, success navigates
 * back to the match-details page.
 */
export function CorrectionEntry({ matchId }: { matchId: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useMatch(matchId);
  const proposeMutation = useProposeResult(matchId);

  // `null` means "not seeded yet" — seeded once `data` arrives (below), so we
  // avoid a state-syncing effect on first render.
  const [drafts, setDrafts] = useState<GameDraft[] | null>(null);
  const [selectedGameNumber, setSelectedGameNumber] = useState(1);
  const meRef = useRef<HTMLInputElement>(null);
  const oppRef = useRef<HTMLInputElement>(null);
  // Synchronous double-submit guard, mirroring score-entry's `finalizingRef`
  // (#641): `proposeMutation.isPending` is a render snapshot that only takes
  // effect on the next commit, so a same-frame double-tap can land a second
  // submit before React re-renders. This ref flips synchronously inside the
  // submit gesture, so it catches the second tap even within the same frame.
  const submittingRef = useRef(false);

  if (isLoading || !data) {
    return <div aria-busy="true" data-testid="correction-entry-loading" />;
  }

  const standing = data.negotiation.standing_result;
  const mySide = data.sides.find((s) => s.is_current_user_side) ?? null;
  const oppSide = data.sides.find((s) => !s.is_current_user_side) ?? null;
  // The correction flow only applies to participants with a standing result on
  // a match still open for negotiation: `review`/`corrected` (an opponent's
  // proposal to react to) and `awaiting` (editing the viewer's own pending
  // proposal, via the match-detail "Edit result" action) all belong here.
  // `final` is the one open-negotiation-shaped exception — it still carries a
  // `standing_result` (the settled score), so that check alone doesn't catch
  // it, but the match is locked and must bounce back instead of rendering a
  // live, submittable editor on direct nav (#730).
  const settled = data.negotiation.viewer_state === "final";
  if (!standing || !mySide || !oppSide || settled) {
    return <Navigate {...matchDetailRoute(matchId)} />;
  }

  // Captured here (rather than read inside `onSubmit`) so the standing-result
  // narrowing from the guard above survives into the submit closure.
  const standingId = standing.id;
  const bestOf = data.best_of;
  const gamesToWin = data.games_to_win;
  const mySideNumber: 1 | 2 = mySide.side_number === 2 ? 2 : 1;
  const meName = mySide.players[0]?.username ?? "You";
  const meInitials = initialsOf(meName);
  const oppUsername = oppSide.players[0]?.username ?? null;
  const oppName = oppUsername ?? NO_OPPONENT_LABEL;
  const oppHasPlayer = oppUsername !== null;

  // The proposer editing their own still-pending proposal (reached via the
  // match-detail "Edit result" action, `viewer_state: "awaiting"`) isn't
  // correcting anyone — frame the copy as an edit. The reviewer reacting to the
  // opponent's proposal (`review`/`corrected`) is suggesting a correction.
  const isSelfEdit = data.negotiation.viewer_state === "awaiting";
  const heading = isSelfEdit ? "Edit your result." : "Suggest a correction.";
  const scoreNoun = isSelfEdit ? "updated" : "corrected";
  const hintLead = isSelfEdit
    ? "Adjust the game(s) you need to change"
    : "Fix the game(s) that look off";

  const current = drafts ?? seedDrafts(standing.games, mySideNumber, bestOf);
  const selected =
    current.find((d) => d.gameNumber === selectedGameNumber) ?? current[0];

  const setGame = (gameNumber: number, next: Partial<GameDraft>) => {
    setDrafts(
      current.map((d) => (d.gameNumber === gameNumber ? { ...d, ...next } : d)),
    );
    if (proposeMutation.error) proposeMutation.reset();
  };

  // Per-game verdicts across the whole buffer: a game with any input must be a
  // legal, completed score for the board to be submittable; wholly-empty slots
  // are just "not played yet".
  const draftStates = current.map((d) => ({
    draft: d,
    validation: validateGameScore(d.me, d.opp),
    hasInput: d.me !== "" || d.opp !== "",
  }));
  const allEnteredValid = draftStates.every(
    (s) => !s.hasInput || s.validation.valid,
  );
  const validDrafts = draftStates
    .filter((s) => s.validation.valid)
    .map((s) => s.draft);

  // The orientation-restored board — the single source for both the
  // completeness check and the submit payload, so what we validate is exactly
  // what we post. Only legal, completed games make the board; ordered by game
  // number so the contiguity/decider rules read it correctly.
  const correctedGames: MatchResultsGameWrite[] = validDrafts
    .map((d) =>
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
    )
    .sort((a, b) => a.game_number - b.game_number);

  // Validate the board as a *whole* the same way the score-entry page does live
  // and the server does on submit: a correction that leaves the match undecided
  // (a BO5 board edited to 2–1) must block submit, not only fail on the server
  // (#734). Only meaningful once every entered game is individually legal.
  const boardError = allEnteredValid
    ? firstMatchScoreError(correctedGames, bestOf)
    : null;
  const canSubmit = allEnteredValid && boardError === null;

  // The running games tally (viewer-left), shown under the VS divider on
  // multi-game matches so the corrector can see how close the board is to
  // decided.
  const myWins = validDrafts.filter((d) => Number(d.me) > Number(d.opp)).length;
  const oppWins = validDrafts.filter(
    (d) => Number(d.opp) > Number(d.me),
  ).length;
  const gamesTally = bestOf > 1 ? `${myWins} – ${oppWins}` : null;

  // The board-level hint that explains a disabled Send. Three cases: an entered
  // game is incomplete/illegal (a half-filled non-selected game leaves Send
  // dead with nothing on the open pad to explain it); the board is a clean but
  // undecided prefix (just needs more games — the friendly add-games copy); or
  // a structural error (gap, too many games, a game after the decider) for
  // which the lib's message is the clearest thing to say.
  const contiguous = correctedGames.every((g, i) => g.game_number === i + 1);
  const someoneWon = myWins >= gamesToWin || oppWins >= gamesToWin;
  let boardHint: string | null = null;
  if (!allEnteredValid) {
    boardHint =
      "Finish entering each game — one or more games have only one score or an illegal score.";
  } else if (boardError !== null) {
    boardHint =
      contiguous && !someoneWon
        ? "This isn't a finished match yet — add the remaining game(s) until someone wins."
        : boardError;
  }

  // A 409 means the standing result moved on (someone else proposed/accepted
  // since this screen loaded); a 422 means the board itself was rejected. Both
  // surface inline; everything else falls back to the API message.
  const apiError =
    proposeMutation.error instanceof ApiError ? proposeMutation.error : null;

  const inputsLocked = proposeMutation.isPending;

  // The per-game verdicts and the scoreline view-model both derive from the
  // single `draftStates` pass above, so the validation is computed once per
  // game and the two derivations can't drift.
  const selectedValidation = (
    draftStates.find((s) => s.draft.gameNumber === selected.gameNumber) ??
    draftStates[0]
  ).validation;

  const scorelineCells = draftStates.map(({ draft: d, validation: v, hasInput }) => ({
    gameNumber: d.gameNumber,
    myPoints: d.me === "" ? null : d.me,
    oppPoints: d.opp === "" ? null : d.opp,
    myWin: v.valid ? Number(d.me) > Number(d.opp) : null,
    invalid: hasInput && !v.valid,
  }));

  function onSubmit() {
    if (!canSubmit) return;
    if (proposeMutation.isPending || submittingRef.current) return;
    submittingRef.current = true;
    proposeMutation.mutate(
      { games: correctedGames, supersedes_result_id: standingId },
      {
        onSuccess: () => navigate(matchDetailRoute(matchId)),
        onError: () => {
          submittingRef.current = false;
        },
      },
    );
  }

  function onClearSelected() {
    setGame(selectedGameNumber, { me: "", opp: "" });
    // Same page (no remount), so re-grab the me-input for the next entry.
    meRef.current?.focus();
  }

  function handleKey(
    e: React.KeyboardEvent<HTMLInputElement>,
    side: "me" | "opp",
  ) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (side === "me" && selected.me !== "") {
        oppRef.current?.focus();
        oppRef.current?.select();
      } else if (side === "opp") {
        // Enter on the opponent field advances to the next game (the pad
        // remounts on the new game number and auto-focuses its me-input); on
        // the last slot it submits the board instead of dead-ending.
        if (selectedGameNumber < bestOf) {
          setSelectedGameNumber(selectedGameNumber + 1);
        } else {
          onSubmit();
        }
      }
    } else if (e.key === "ArrowRight" && side === "me") {
      e.preventDefault();
      oppRef.current?.focus();
      oppRef.current?.select();
    } else if (e.key === "ArrowLeft" && side === "opp") {
      e.preventDefault();
      meRef.current?.focus();
      meRef.current?.select();
    }
  }

  return (
    <div className="entry-wrap">
      <div className="entry-head">
        <h2>{heading}</h2>
        <div className="hint">
          {hintLead} — switch games on the SCORELINE, add or remove games until
          the board has a winner, then send the {scoreNoun} score to {oppName} to
          accept.
        </div>
      </div>

      {apiError !== null && (
        <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
          {apiError.status === 409
            ? "This proposal has moved on — reload the match to see the latest score."
            : (apiError.detail ?? apiError.message)}
        </p>
      )}

      {boardHint !== null && (
        <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
          {boardHint}
        </p>
      )}

      <ScorePad
        // Remount on game switch so the inputs re-seed and the me-field
        // auto-focuses for the newly-opened game.
        key={selected.gameNumber}
        me={{
          name: meName,
          initials: meInitials,
          value: selected.me,
          inputRef: meRef,
          autoFocus: true,
          // Red-flag this field when its own value is malformed, or when a
          // pair-level rule violation (tie/deuce) makes neither side
          // individually malformed — but NOT when only the *other* side is.
          invalid:
            selectedValidation.meMalformed ||
            (selectedValidation.error !== null &&
              !selectedValidation.meMalformed &&
              !selectedValidation.oppMalformed),
          onChange: (value) => {
            if (!isAcceptableScoreInput(value)) return;
            setGame(selected.gameNumber, { me: value });
          },
          onKeyDown: (e) => handleKey(e, "me"),
        }}
        opp={{
          name: oppName,
          initials: oppHasPlayer ? initialsOf(oppName) : null,
          value: selected.opp,
          inputRef: oppRef,
          invalid:
            selectedValidation.oppMalformed ||
            (selectedValidation.error !== null &&
              !selectedValidation.meMalformed &&
              !selectedValidation.oppMalformed),
          onChange: (value) => {
            if (!isAcceptableScoreInput(value)) return;
            setGame(selected.gameNumber, { opp: value });
          },
          onKeyDown: (e) => handleKey(e, "opp"),
        }}
        gamesTally={gamesTally}
        scoreError={selectedValidation.error}
        showBothRequired={
          selectedValidation.oneSideFilled && selectedValidation.error === null
        }
        inputsLocked={inputsLocked}
        subtitle={`Sending the ${scoreNoun} score posts the result for ${oppName} to accept.`}
        submitLabel={
          proposeMutation.isPending ? "Sending…" : `Send ${scoreNoun} score`
        }
        canSubmit={canSubmit}
        onSubmit={onSubmit}
        onClear={onClearSelected}
        clearDisabled={selected.me === "" && selected.opp === ""}
      />

      <CorrectionScoreline
        cells={scorelineCells}
        activeGameNumber={selected.gameNumber}
        onSelect={setSelectedGameNumber}
        onClear={(n) => setGame(n, { me: "", opp: "" })}
      />
    </div>
  );
}
