/**
 * Loading placeholder for the Career card, shown as its `<Suspense>` fallback.
 * Hand-mirrors `CareerCardDisplay`'s markup — the heading, the ring and the two
 * tiles — so the card holds its shape while the bundle resolves. Revisit it if
 * that structure changes.
 */
export const CareerCardSkeleton = () => (
  <section
    className="player-profile__section career-card"
    role="status"
    aria-busy="true"
    aria-label="Loading career"
  >
    <div className="player-profile__section-header" aria-hidden="true">
      <span className="player-profile__section-title">Career</span>
    </div>
    <div className="career-card__body" aria-hidden="true">
      <div className="career-card__headline">
        <div className="career-card__ring career-card__ring--skeleton" />
        <div className="career-card__figures">
          <span className="career-card__skeleton-line" />
          <span className="career-card__skeleton-line career-card__skeleton-line--pill" />
        </div>
      </div>
      <div className="career-card__tiles">
        <div className="career-card__tile career-card__tile--skeleton" />
        <div className="career-card__tile career-card__tile--skeleton" />
      </div>
    </div>
  </section>
)
