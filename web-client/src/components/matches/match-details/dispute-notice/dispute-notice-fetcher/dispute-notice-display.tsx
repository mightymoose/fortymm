import type { DisputeNoticeView } from "./dispute-notice-query";

export interface DisputeNoticeDisplayProps {
  view: DisputeNoticeView;
}

/** Tells the submitter their posted result was disputed and what to do about
 * it. Rendered in the same callout slot as the confirmation callout (which
 * goes quiet on a disputed match), so it mirrors that surface's featured
 * treatment. The re-score action itself is the header "Score" CTA, which is
 * already present once the dispute reopens scoring. */
export function DisputeNoticeDisplay({ view }: DisputeNoticeDisplayProps) {
  return (
    <section
      className="md-confirm-callout md-confirm-callout--featured"
      data-testid="match-dispute-notice"
    >
      <div className="md-confirm-callout__copy">
        <div className="md-confirm-callout__kicker">
          <span className="ball-dot" aria-hidden="true" /> Result disputed
        </div>
        <h3 className="md-confirm-callout__headline">
          {view.disputerName} disputed your result.
        </h3>
        <p className="md-confirm-callout__body">
          Re-score the wrong game and post the result again to send it back for
          sign-off.
        </p>
      </div>
    </section>
  );
}
