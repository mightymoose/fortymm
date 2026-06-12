export interface FinalizeCalloutDisplayProps {
  /** True while the post-result request is in flight — disables the CTA and
   * swaps its label to "Posting…". */
  pending: boolean;
  /** Inline API failure to surface beneath the body copy; null when the last
   * attempt succeeded or none has been made. */
  errorMessage: string | null;
  onPost: () => void;
}

export function FinalizeCalloutDisplay({
  pending,
  errorMessage,
  onPost,
}: FinalizeCalloutDisplayProps) {
  return (
    <section
      className="md-confirm-callout md-confirm-callout--featured"
      data-testid="match-finalize-callout"
    >
      <div className="md-confirm-callout__copy">
        <div className="md-confirm-callout__kicker">
          <span className="ball-dot" aria-hidden="true" /> Scores ready · not
          yet posted
        </div>
        <h3 className="md-confirm-callout__headline">
          Post this result for your opponent to confirm.
        </h3>
        <p className="md-confirm-callout__body">
          These scores already decide the match but haven't been posted. Post
          them as-is to send the result for sign-off, or edit any game in the
          scoreboard below first.
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
          disabled={pending}
          onClick={onPost}
        >
          {pending ? "Posting…" : "Post result"}
        </button>
      </div>
    </section>
  );
}
