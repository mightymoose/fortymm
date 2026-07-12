/**
 * Loading placeholder for the Head-to-head card, shown as its `<Suspense>`
 * fallback. Hand-mirrors `HeadToHeadCardDisplay` — the heading, the lead line and
 * three opponent rows — so the card holds its shape while the bundle resolves.
 * Revisit it if that structure changes.
 *
 * Its accessible name is "Loading head-to-head", which deliberately matches none
 * of the other cards' skeleton names (`/loading player/i`, `/loading rating/i`,
 * `/loading career/i`, `/loading confidence/i`, `/loading leagues/i`,
 * `/loading matches/i`) — a second match would break the profile page object's
 * queries rather than this card's.
 *
 * It cannot know which card it is about to become: the lead line is there for the
 * "You're 1–4 against them" the stranger's view opens with, and simply resolves
 * away on your own profile, where there is no record to show.
 */
export const HeadToHeadCardSkeleton = () => (
  <section
    className="player-profile__section head-to-head"
    role="status"
    aria-busy="true"
    aria-label="Loading head-to-head"
  >
    <div className="player-profile__section-header" aria-hidden="true">
      <span className="player-profile__section-title">Head-to-head</span>
    </div>
    <div className="head-to-head__body" aria-hidden="true">
      <span className="head-to-head__skeleton-line head-to-head__skeleton-line--lead" />
      <span className="head-to-head__skeleton-line" />
      <span className="head-to-head__skeleton-line" />
      <span className="head-to-head__skeleton-line" />
    </div>
  </section>
)
