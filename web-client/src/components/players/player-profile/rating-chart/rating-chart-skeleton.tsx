/**
 * Loading placeholder for the rating chart, shown as its `<Suspense>` fallback.
 * Hand-mirrors the card's shape — heading row, caption, plot — so the page does
 * not jump when the line lands.
 *
 * It stands in for the **bundle**, not for the chart's own query: what the card
 * is waiting on here is the profile bundle, which answers whether this player is
 * rated at all (and carries the window the chart will draw first). So, like the
 * confidence card's skeleton, it is honest about not knowing whether there will
 * *be* a chart — an unrated player resolves this into an "Unrated" panel instead.
 *
 * Its accessible name is "Loading chart", deliberately **not** "Loading rating
 * chart": the rating panel's skeleton is already "Loading rating", and the
 * profile's page object finds it with `/loading rating/i`. A second match would
 * break that query rather than this card.
 */
export const RatingChartSkeleton = () => (
  <section
    className="player-profile__section rating-chart"
    role="status"
    aria-busy="true"
    aria-label="Loading chart"
  >
    <div className="player-profile__section-header" aria-hidden="true">
      <span className="player-profile__section-title">Rating over time</span>
    </div>
    <div className="rating-chart__plot" aria-hidden="true">
      <span className="rating-chart__skeleton-plot" />
    </div>
  </section>
)
