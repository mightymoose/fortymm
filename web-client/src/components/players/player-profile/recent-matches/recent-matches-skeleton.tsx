/**
 * Loading placeholder for the Recent matches card, shown as its `<Suspense>`
 * fallback. Hand-mirrors `RecentMatchesDisplay`'s markup — the section heading
 * and six rows — so the card holds its shape while the bundle resolves. Revisit
 * it if that structure changes.
 */
export const RecentMatchesSkeleton = () => (
  <section
    className="player-profile__section recent-matches"
    role="status"
    aria-busy="true"
    aria-label="Loading matches"
  >
    <div className="player-profile__section-header" aria-hidden="true">
      <span className="player-profile__section-title">Recent matches</span>
    </div>
    <div className="recent-matches__skeleton" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div className="recent-matches__skeleton-row" key={i} />
      ))}
    </div>
  </section>
)
