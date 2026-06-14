const SK = "md-sk animate-pulse";

/**
 * Loading placeholder for the {@link MatchInfo} sidebar card, shown as its
 * `<Suspense>` fallback. Reuses the real `.md-card` / `.md-info-row` structural
 * classes so the card chrome and label/value rows occupy the same boxes the
 * loaded card will — only the leaf text becomes shimmer blocks. Renders a
 * representative three rows (the loaded count varies); each row's height is
 * pinned by `.md-info-row`, not the bar inside it. This mirrors
 * `MatchInfoDisplay`'s markup by hand (Suspense unmounts the real tree during
 * load), so revisit it if that structure changes.
 */
export const MatchInfoSkeleton = () => {
  return (
    <section
      className="md-card"
      role="status"
      aria-busy="true"
      aria-label="Loading match info"
    >
      <div className="md-card__hd" aria-hidden="true">
        <span className={`${SK} md-sk--card-title`} />
      </div>
      <div className="md-card__body" aria-hidden="true">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="md-info-row">
            <span className={`${SK} md-sk--info-k`} />
            <span className={`${SK} md-sk--info-v`} />
          </div>
        ))}
      </div>
    </section>
  );
};
