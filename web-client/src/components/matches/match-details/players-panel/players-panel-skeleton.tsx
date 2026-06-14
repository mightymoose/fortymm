const SK = "md-sk animate-pulse";

/** One profile half — identity, rating box, recent-form list, career grid —
 * shimmer-blocked. `.md-players` is a `1fr 1px 1fr` grid, so both halves
 * equalise to the taller profile's height; rendering two full profiles
 * therefore reserves the loaded panel's height even when one real side is the
 * shorter "No opponent" placeholder. Form list uses a representative three
 * rows (the loaded count varies). */
const ProfileSkeleton = () => (
  <div className="md-profile">
    <div className="md-profile__identity">
      <span className={`${SK} md-sk--avatar-48`} />
      <div className="md-profile__id-text">
        <span className={`${SK} md-sk--profile-name`} />
      </div>
    </div>
    <span className={`${SK} md-sk--rating`} />
    <div className="md-profile__form">
      <div className="md-profile__form-summary">
        <span className={`${SK} md-sk--card-title`} />
      </div>
      <ul className="md-profile__form-list">
        {Array.from({ length: 3 }, (_, i) => (
          <li key={i} className="md-form-row">
            <span className={`${SK} md-sk--form-row`} />
          </li>
        ))}
      </ul>
    </div>
    <div className="md-profile__career">
      {Array.from({ length: 4 }, (_, i) => (
        <span key={i} className={`${SK} md-sk--career`} />
      ))}
    </div>
  </div>
);

/**
 * Loading placeholder for the {@link PlayersPanel}, shown as its `<Suspense>`
 * fallback. Reuses the real `.md-card` / `.md-players` / `.md-profile`
 * structural classes so the card chrome and both profile columns occupy the
 * same boxes the loaded panel will — only the leaf text/avatars become shimmer
 * blocks. This mirrors `PlayersPanelDisplay`'s markup by hand (Suspense
 * unmounts the real tree during load), so revisit it if that structure changes.
 */
export const PlayersPanelSkeleton = () => {
  return (
    <section
      className="md-card"
      role="status"
      aria-busy="true"
      aria-label="Loading the players panel"
    >
      <div className="md-card__hd" aria-hidden="true">
        <span className={`${SK} md-sk--card-title`} />
        <span className={`${SK} md-sk--meta`} />
      </div>
      <div className="md-players" aria-hidden="true">
        <ProfileSkeleton />
        <div className="md-players__divider" />
        <ProfileSkeleton />
      </div>
    </section>
  );
};
