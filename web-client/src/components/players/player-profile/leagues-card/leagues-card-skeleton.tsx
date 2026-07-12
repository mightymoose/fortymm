/**
 * Loading placeholder for the Leagues card, shown as its `<Suspense>` fallback.
 * Hand-mirrors `LeaguesCardDisplay`'s markup — the heading and a row — so the
 * card holds its shape while the bundle resolves. Revisit it if that structure
 * changes.
 *
 * One row, not several: every real player today is in exactly one league, so one
 * is the honest guess at the shape about to arrive.
 */
export const LeaguesCardSkeleton = () => (
  <section
    className="player-profile__section leagues-card"
    role="status"
    aria-busy="true"
    aria-label="Loading leagues"
  >
    <div className="player-profile__section-header" aria-hidden="true">
      <span className="player-profile__section-title">Leagues</span>
    </div>
    <ul className="leagues-card__rows" aria-hidden="true">
      <li className="leagues-card__row-item">
        <span className="leagues-card__row leagues-card__row--skeleton" />
      </li>
    </ul>
  </section>
)
