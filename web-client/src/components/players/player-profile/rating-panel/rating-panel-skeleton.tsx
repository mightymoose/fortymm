/**
 * Loading placeholder for the hero's standing card, shown as its `<Suspense>`
 * fallback. Hand-mirrors `RatingPanelDisplay`'s markup — the overline, the big
 * rating chip, two stat lines and a run of form chips — so the card holds its
 * shape while the bundle resolves. Revisit it if that structure changes.
 */
export const RatingPanelSkeleton = () => (
  <section
    className="player-profile__standing"
    role="status"
    aria-busy="true"
    aria-label="Loading rating"
  >
    <div className="player-profile__overline" aria-hidden="true">
      FortyMM Rating
    </div>
    <div className="player-profile__rating-row" aria-hidden="true">
      <div className="player-profile__hero-rating-chip player-profile__hero-rating-chip--skeleton" />
    </div>
    <div className="player-profile__stats" aria-hidden="true">
      {Array.from({ length: 2 }, (_, i) => (
        <div className="player-profile__stat" key={i}>
          <span className="player-profile__stat-skeleton" />
        </div>
      ))}
    </div>
    <div className="player-profile__form-row" aria-hidden="true">
      <span className="player-profile__form-label">Form</span>
      <span className="player-profile__form">
        {Array.from({ length: 10 }, (_, i) => (
          <span
            className="player-profile__form-chip player-profile__form-chip--skeleton"
            key={i}
          />
        ))}
      </span>
    </div>
  </section>
)
