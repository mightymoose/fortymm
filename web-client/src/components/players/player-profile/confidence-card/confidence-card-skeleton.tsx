/**
 * Loading placeholder for the Rating confidence card, shown as its `<Suspense>`
 * fallback. Hand-mirrors `ConfidenceCardDisplay`'s markup — the heading, the
 * level line, the copy and the interval — so the card holds its shape while the
 * bundle resolves. Revisit it if that structure changes.
 *
 * Its accessible name is "Loading confidence", deliberately *not* "Loading rating
 * confidence": the rating panel's skeleton is already "Loading rating", and the
 * profile's page object finds it by `/loading rating/i`. A second match would
 * break that query rather than this card.
 *
 * It is honest about one thing it cannot know: whether there will *be* a card.
 * A player with no rating has no confidence, so this skeleton can resolve into
 * nothing at all.
 */
export const ConfidenceCardSkeleton = () => (
  <section
    className="player-profile__section confidence-card"
    role="status"
    aria-busy="true"
    aria-label="Loading confidence"
  >
    <div className="player-profile__section-header" aria-hidden="true">
      <span className="player-profile__section-title">Rating confidence</span>
    </div>
    <div className="confidence-card__body" aria-hidden="true">
      <span className="confidence-card__skeleton-line confidence-card__skeleton-line--level" />
      <span className="confidence-card__skeleton-line" />
      <span className="confidence-card__skeleton-line confidence-card__skeleton-line--interval" />
    </div>
  </section>
)
