import { Overline } from "@/components/overline";

import type { ConfirmationCalloutView } from "../confirmation-callout-query";

export interface ConfirmationCalloutDisplayProps {
  view: ConfirmationCalloutView;
  /** True while the accept request is in flight — swaps the Accept label to
   * "Accepting…" and disables the CTA. */
  acceptPending: boolean;
  /** Inline API failure to surface beneath the body copy; null when the last
   * attempt succeeded or none has been made. */
  errorMessage: string | null;
  onAccept: () => void;
}

export function ConfirmationCalloutDisplay({
  view,
  acceptPending,
  errorMessage,
  onAccept,
}: ConfirmationCalloutDisplayProps) {
  if (view.kind === "actionable") {
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
            match.
          </p>
          {errorMessage && (
            <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
              {errorMessage}
            </p>
          )}
        </div>
        <div className="md-confirm-callout__actions">
          <button
            type="button"
            className="md-btn md-btn--primary"
            disabled={acceptPending}
            onClick={onAccept}
          >
            {acceptPending ? "Accepting…" : "Accept result"}
          </button>
        </div>
      </section>
    );
  }

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
        {errorMessage && (
          <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
            {errorMessage}
          </p>
        )}
      </div>
    </section>
  );
}
