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
  /** Inline API failure to surface beneath the body copy; null when the last
   * attempt succeeded or none has been made. */
  errorMessage: string | null;
  onAccept: () => void;
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

export function ConfirmationCalloutDisplay({
  view,
  matchId,
  acceptPending,
  errorMessage,
  onAccept,
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
          <StakesLine rated={view.rated} />
          <ErrorLine message={errorMessage} />
        </div>
        <div className="md-confirm-callout__actions">
          <AcceptButton acceptPending={acceptPending} onAccept={onAccept} />
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
          <StakesLine rated={view.rated} />
          <ErrorLine message={errorMessage} />
        </div>
        <div className="md-confirm-callout__actions">
          <AcceptButton acceptPending={acceptPending} onAccept={onAccept} />
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

  // The match is settled — a quiet confirmation, no action to press.
  if (view.kind === "final") {
    return (
      <section
        className="md-confirm-callout md-confirm-callout--passive"
        data-testid="match-confirm-callout"
      >
        <div className="md-confirm-callout__copy">
          <Overline as="h3">
            {view.afterCorrections ? "Agreed after corrections" : "Confirmed"}
          </Overline>
          <p className="md-confirm-callout__body">
            {view.afterCorrections
              ? "Both sides agreed on the final score after corrections. This match is settled."
              : "Both sides confirmed this result. This match is settled."}
          </p>
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
