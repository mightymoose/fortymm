/**
 * Loading placeholder for the hero's identity card, shown as its `<Suspense>`
 * fallback. Hand-mirrors `ProfileHeroDisplay`'s markup (Suspense unmounts the
 * real tree while it loads) so the avatar, name and member-since line occupy the
 * same boxes they will once the bundle resolves — revisit it if that structure
 * changes.
 */
export const ProfileHeroSkeleton = () => (
  <div
    className="player-profile__identity"
    role="status"
    aria-busy="true"
    aria-label="Loading player"
  >
    <div className="player-profile__avatar-ring" aria-hidden="true">
      <span className="player-profile__hero-avatar-skeleton" />
      <span className="player-profile__avatar-dashed" />
    </div>
    <div className="player-profile__name-wrap" aria-hidden="true">
      <div className="player-profile__overline">FortyMM Player</div>
      <div className="player-profile__hero-name-skeleton" />
      <div className="player-profile__hero-sub-skeleton" />
    </div>
  </div>
)
