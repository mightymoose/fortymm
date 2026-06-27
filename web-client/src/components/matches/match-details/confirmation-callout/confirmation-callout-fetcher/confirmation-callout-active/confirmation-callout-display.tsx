import { Overline } from "@/components/overline";

import type { ConfirmationCalloutView } from "../confirmation-callout-query";

export interface ConfirmationCalloutDisplayProps {
  view: ConfirmationCalloutView;
  /** True while the confirm request is in flight — swaps the Confirm label
   * to "Confirming…" and disables both CTAs. */
  confirmPending: boolean;
  /** True while the dispute request is in flight — swaps the Dispute label
   * to "Disputing…" and disables both CTAs. */
  disputePending: boolean;
  /** True while the withdraw request is in flight — swaps the Withdraw label
   * to "Withdrawing…" and disables the CTA. */
  withdrawPending: boolean;
  /** Inline API failure to surface beneath the body copy; null when the last
   * attempt succeeded or none has been made. */
  errorMessage: string | null;
  onConfirm: () => void;
  onDispute: () => void;
  onWithdraw: () => void;
}

export function ConfirmationCalloutDisplay({
  view,
  confirmPending,
  disputePending,
  withdrawPending,
  errorMessage,
  onConfirm,
  onDispute,
  onWithdraw,
}: ConfirmationCalloutDisplayProps) {
  if (view.kind === "actionable") {
    const pending = confirmPending || disputePending;
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
            Confirm the result to finalize this match.
          </h3>
          <p className="md-confirm-callout__body">
            Your opponent has posted the result below. Confirm if the scores
            are right, or dispute to send the match back to in-progress so the
            wrong game can be re-scored.
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
            className="md-btn md-btn--ghost"
            disabled={pending}
            onClick={onDispute}
          >
            {disputePending ? "Disputing…" : "Dispute"}
          </button>
          <button
            type="button"
            className="md-btn md-btn--primary"
            disabled={pending}
            onClick={onConfirm}
          >
            {confirmPending ? "Confirming…" : "Confirm result"}
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
        <Overline as="h3">Posted · awaiting confirmation</Overline>
        <p className="md-confirm-callout__body">
          You've posted this result. Waiting on{" "}
          <strong>{view.pendingSignerName}</strong> to confirm or dispute
          before the match is finalized.
          {view.canWithdraw && (
            <>
              {" "}
              Spotted a mistake? Withdraw it to re-score and post again.
            </>
          )}
        </p>
        {errorMessage && (
          <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
            {errorMessage}
          </p>
        )}
      </div>
      {view.canWithdraw && (
        <div className="md-confirm-callout__actions">
          <button
            type="button"
            className="md-btn md-btn--ghost"
            disabled={withdrawPending}
            onClick={onWithdraw}
          >
            {withdrawPending ? "Withdrawing…" : "Withdraw result"}
          </button>
        </div>
      )}
    </section>
  );
}
