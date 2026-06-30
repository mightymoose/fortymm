import { Link } from "@tanstack/react-router";

import { correctionRoute } from "@/api/matches";
import { Overline } from "@/components/overline";

import { ScoreDiff } from "../../../score-diff/score-diff";
import type { ConfirmationCalloutView } from "../confirmation-callout-query";

export interface ConfirmationCalloutDisplayProps {
  view: ConfirmationCalloutView;
  /** The match id, used to build the correction-route links. */
  matchId: string;
  /** True while the accept request is in flight — swaps the Accept label to
   * "Accepting…" and disables the CTA. */
  acceptPending: boolean;
  /** True when the last accept 409'd because the standing result moved on. The
   * actionable callouts then swap Accept for a "reload to re-review" prompt so
   * the viewer can't blindly finalize a correction they never saw (#726). */
  staleConflict: boolean;
  /** Inline API failure to surface beneath the body copy; null when the last
   * attempt succeeded, none has been made, or it was a `staleConflict` (which
   * has its own dedicated copy + reload button). */
  errorMessage: string | null;
  onAccept: () => void;
  /** Refetch the match so the viewer sees (and can re-review) the latest
   * standing result. Wired to the `staleConflict` reload button. */
  onReload: () => void;
}

/** The rated/unrated stakes line, shared by the review + corrected callouts. */
function StakesLine({ rated }: { rated: boolean }) {
  return (
    <p className="md-confirm-callout__stakes text-xs text-[color:var(--muted)]">
      {rated
        ? "Accepting finalizes this rated match and updates both ratings."
        : "Accepting finalizes this match. It doesn't affect ratings."}
    </p>
  );
}

function AcceptButton({
  acceptPending,
  onAccept,
}: {
  acceptPending: boolean;
  onAccept: () => void;
}) {
  return (
    <button
      type="button"
      className="md-btn md-btn--primary"
      disabled={acceptPending}
      onClick={onAccept}
    >
      {acceptPending ? "Accepting…" : "Accept result"}
    </button>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
      {message}
    </p>
  );
}

/** Shown when an accept 409'd: the standing result moved on, so we prompt a
 * re-review instead of silently retargeting the live result (#726). Mirrors the
 * correction-entry "this proposal has moved on" copy. */
function StaleConflictNotice() {
  return (
    <p
      role="alert"
      className="md-confirm-callout__stakes mt-1.5 text-xs text-[color:var(--warn)]"
    >
      This result changed — reload to review the latest score before accepting.
    </p>
  );
}

function ReloadButton({ onReload }: { onReload: () => void }) {
  return (
    <button type="button" className="md-btn md-btn--primary" onClick={onReload}>
      Reload
    </button>
  );
}

/** The copy beneath the body of an actionable callout: the stale-result reload
 * notice when the standing result moved on, otherwise the stakes line plus any
 * inline API error. Shared verbatim by the review + corrected variants. */
function CalloutBody({
  staleConflict,
  rated,
  errorMessage,
}: {
  staleConflict: boolean;
  rated: boolean;
  errorMessage: string | null;
}) {
  if (staleConflict) return <StaleConflictNotice />;
  return (
    <>
      <StakesLine rated={rated} />
      <ErrorLine message={errorMessage} />
    </>
  );
}

/** The primary CTA of an actionable callout: Reload after a stale-result 409,
 * otherwise Accept. Shared verbatim by the review + corrected variants. */
function PrimaryAction({
  staleConflict,
  acceptPending,
  onAccept,
  onReload,
}: {
  staleConflict: boolean;
  acceptPending: boolean;
  onAccept: () => void;
  onReload: () => void;
}) {
  if (staleConflict) return <ReloadButton onReload={onReload} />;
  return <AcceptButton acceptPending={acceptPending} onAccept={onAccept} />;
}

export function ConfirmationCalloutDisplay({
  view,
  matchId,
  acceptPending,
  staleConflict,
  errorMessage,
  onAccept,
  onReload,
}: ConfirmationCalloutDisplayProps) {
  // The opponent posted the first result — accept it or suggest a correction.
  if (view.kind === "review") {
    return (
      <section
        className="md-confirm-callout md-confirm-callout--featured"
        data-testid="match-confirm-callout"
      >
        <div className="md-confirm-callout__copy">
          <div className="md-confirm-callout__kicker">
            <span className="ball-dot" aria-hidden="true" /> Posted result ·
            awaiting your sign-off
          </div>
          <h3 className="md-confirm-callout__headline">
            Accept the result to finalize this match.
          </h3>
          <p className="md-confirm-callout__body">
            Your opponent has posted the result below. Accept it to finalize the
            match, or suggest a correction if the score looks off.
          </p>
          <CalloutBody
            staleConflict={staleConflict}
            rated={view.rated}
            errorMessage={errorMessage}
          />
        </div>
        <div className="md-confirm-callout__actions">
          <PrimaryAction
            staleConflict={staleConflict}
            acceptPending={acceptPending}
            onAccept={onAccept}
            onReload={onReload}
          />
          <Link
            {...correctionRoute(matchId)}
            className="md-btn md-btn--ghost"
            data-testid="match-confirm-callout-correct"
          >
            Suggest correction
          </Link>
        </div>
      </section>
    );
  }

  // The opponent countered the viewer's own prior proposal — show the diff and
  // let the viewer accept the correction or counter back.
  if (view.kind === "corrected") {
    return (
      <section
        className="md-confirm-callout md-confirm-callout--featured"
        data-testid="match-confirm-callout"
      >
        <div className="md-confirm-callout__copy">
          <div className="md-confirm-callout__kicker">
            <span className="ball-dot" aria-hidden="true" /> Corrected result ·
            awaiting your sign-off
          </div>
          <h3 className="md-confirm-callout__headline">
            Your opponent corrected the score.
          </h3>
          <p className="md-confirm-callout__body">
            Review what changed, then accept the corrected result or counter
            with your own.
          </p>
          {view.diff.length > 0 && <ScoreDiff diff={view.diff} />}
          <CalloutBody
            staleConflict={staleConflict}
            rated={view.rated}
            errorMessage={errorMessage}
          />
        </div>
        <div className="md-confirm-callout__actions">
          <PrimaryAction
            staleConflict={staleConflict}
            acceptPending={acceptPending}
            onAccept={onAccept}
            onReload={onReload}
          />
          <Link
            {...correctionRoute(matchId)}
            className="md-btn md-btn--ghost"
            data-testid="match-confirm-callout-counter"
          >
            Counter
          </Link>
        </div>
      </section>
    );
  }

  // `awaiting`: the viewer posted; we wait on the opponent. Passive notice with
  // an "Edit result" self-edit that supersedes the viewer's standing proposal.
  return (
    <section
      className="md-confirm-callout md-confirm-callout--passive"
      data-testid="match-confirm-callout"
    >
      <div className="md-confirm-callout__copy">
        <Overline as="h3">Posted · awaiting acceptance</Overline>
        <p className="md-confirm-callout__body">
          You've posted this result. Waiting on{" "}
          <strong>{view.pendingSignerName}</strong> to accept before the match
          is finalized.
        </p>
        <ErrorLine message={errorMessage} />
      </div>
      <div className="md-confirm-callout__actions">
        <Link
          {...correctionRoute(matchId)}
          className="md-btn md-btn--ghost"
          data-testid="match-confirm-callout-edit"
        >
          Edit result
        </Link>
      </div>
    </section>
  );
}
