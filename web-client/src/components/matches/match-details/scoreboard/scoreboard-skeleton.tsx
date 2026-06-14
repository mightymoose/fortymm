import { Fragment } from "react";

const SK = "md-sk animate-pulse";

/**
 * Loading placeholder for the {@link Scoreboard}, shown as the `<Suspense>`
 * fallback while the match-details query resolves.
 *
 * It deliberately reuses the real scoreboard's structural classes
 * (`md-hero__*`, `md-games__*`) rather than re-stating any dimensions: the
 * card chrome, heading strip, hero row and game grid occupy the exact same
 * boxes the loaded scoreboard will, so swapping the skeleton for real content
 * causes no layout shift. Only the leaf text/avatars become shimmer blocks.
 * This mirrors `ScoreboardDisplay`'s markup by hand (Suspense unmounts the real
 * tree during load), so revisit it if that structure changes.
 *
 * The grid is rendered at the CSS default of five game columns. A best-of-3
 * match has fewer columns, but column count only changes horizontal layout —
 * the two player rows are a fixed height regardless — so vertical position of
 * everything below the scoreboard is unaffected. An *upcoming* match has no
 * game grid at all; we show one here because the common case for sitting
 * through a load is a live/final match, and that case shifts zero.
 */
export const ScoreboardSkeleton = () => {
  const gameColumns = 5;

  return (
    <section
      className="md-hero"
      role="status"
      aria-busy="true"
      aria-label="Loading match scoreboard"
    >
      <div className="md-hero__grid-bg" aria-hidden="true" />

      <div className="md-hero__strip" aria-hidden="true">
        <div className="md-hero__strip-l">
          <span className={`${SK} md-sk--chip`} />
        </div>
        <div className="md-hero__strip-r">
          <span className={`${SK} md-sk--meta`} />
          <span className={`${SK} md-sk--meta md-sk--meta-sm`} />
        </div>
      </div>

      <div className="md-hero__row" aria-hidden="true">
        <div className="md-hero__player md-hero__player--l">
          <div className="md-hero__player-row">
            <span className={`${SK} md-sk--avatar`} />
            <span className={`${SK} md-sk--name`} />
          </div>
        </div>

        <div className="md-hero__score-block">
          <div className="md-hero__score-row">
            <span className={`${SK} md-sk--score md-sk--score-l`} />
            <span className={`${SK} md-sk--score-dash`} />
            <span className={`${SK} md-sk--score md-sk--score-r`} />
          </div>
        </div>

        <div className="md-hero__player md-hero__player--r">
          <div className="md-hero__player-row">
            <span className={`${SK} md-sk--avatar`} />
            <span className={`${SK} md-sk--name`} />
          </div>
        </div>
      </div>

      <div className="md-games" aria-hidden="true">
        <div
          className="md-games__grid"
          style={{ "--md-games-count": gameColumns } as React.CSSProperties}
        >
          <span className={`${SK} md-sk--g-kicker`} />
          {Array.from({ length: gameColumns }, (_, i) => (
            <span key={`label-${i}`} className={`${SK} md-sk--g-label`} />
          ))}
          <span className={`${SK} md-sk--g-label`} />

          {Array.from({ length: 2 }, (_, rowIndex) => (
            <Fragment key={`row-${rowIndex}`}>
              <div className="md-games__player">
                <span className={`${SK} md-sk--g-avatar`} />
                <span className={`${SK} md-sk--g-name`} />
              </div>
              {Array.from({ length: gameColumns }, (_, i) => (
                <div key={`cell-${i}`} className="md-games__cell">
                  <span className={`${SK} md-sk--g-cell`} />
                </div>
              ))}
              <div className="md-games__total">
                <span className={`${SK} md-sk--g-total`} />
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
};
