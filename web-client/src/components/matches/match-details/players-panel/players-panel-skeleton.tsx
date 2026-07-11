import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";

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
      <div className="md-kicker">
        <span className={`${SK} md-sk--g-kicker`} />
      </div>
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
    {/* `CareerStats` always renders exactly two tiles (matches, win rate) in a
       1fr/1fr grid — a single row. */}
    <div className="md-profile__career">
      {Array.from({ length: 2 }, (_, i) => (
        <span key={i} className={`${SK} md-sk--career`} />
      ))}
    </div>
  </div>
);

/**
 * Loading placeholder for the {@link PlayersPanel}, shown as its `<Suspense>`
 * fallback. Reuses the same shared `Card` chrome (#218) and the same
 * `.md-players` / `.md-profile` structural classes as the loaded panel, so the
 * card and both profile columns occupy the boxes the loaded panel will — only
 * the leaf text/avatars become shimmer blocks. The `asChild` card keeps the
 * status region a `<section>` the same way the display stays a landmark. This
 * mirrors `PlayersPanelDisplay`'s markup by hand (Suspense unmounts the real
 * tree during load), so revisit it if that structure changes.
 */
export const PlayersPanelSkeleton = () => {
  return (
    <Card asChild>
      <section
        role="status"
        aria-busy="true"
        aria-label="Loading the players panel"
      >
        <CardHeader aria-hidden="true">
          <span className={`${SK} md-sk--card-title`} />
          {/* `self-center` mirrors the loaded caption, which centres against
              the overline in `CardHeader`'s `items-start` grid — so the
              shimmer sits where the real text will. No colour class: the
              placeholder is a shimmer block, not text. */}
          <CardAction className="self-center">
            <span className={`${SK} md-sk--meta`} />
          </CardAction>
        </CardHeader>
        {/* Padding-free for the same reason as the loaded panel: `.md-players`
            is a full-bleed grid and each `.md-profile` half pads itself. */}
        <CardContent className="md-players px-0" aria-hidden="true">
          <ProfileSkeleton />
          <div className="md-players__divider" />
          <ProfileSkeleton />
        </CardContent>
      </section>
    </Card>
  );
};
