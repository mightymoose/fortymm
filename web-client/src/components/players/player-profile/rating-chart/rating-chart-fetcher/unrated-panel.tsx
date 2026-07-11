import { useId } from 'react'

/**
 * What sits in the chart's slot for a player who has **never held a rating**.
 *
 * Not an empty chart. A rating chart is a picture of a rating moving, and there
 * is no rating here to have moved: an axis with no line, or a flat line at a
 * rating that does not exist, would both be fiction. So the card is replaced by
 * the one true thing there is to say — you are unrated, and here is what ends
 * that — consistent with the hero, which reads "Unrated", and the confidence
 * card, which does not render at all (`CONTEXT.md` § *Rating*).
 *
 * It is a panel rather than nothing, unlike the confidence card, because it has
 * something to *tell* the reader: an unrated player is one finished rated match
 * away from having a chart, and that is worth a sentence.
 */
export const UnratedPanel = () => {
  const id = useId()

  return (
    <section
      className="player-profile__section rating-chart rating-chart--unrated"
      aria-labelledby={id}
    >
      <div className="player-profile__section-header">
        <h2 className="player-profile__section-title" id={id}>
          Rating over time
        </h2>
      </div>
      <div className="rating-chart__unrated">
        {/* One sentence, one element — deliberately not a bold "Unrated" over a
         * line of body copy. The hero is the page's one canonical "Unrated", and a
         * second element whose text is exactly that word would make the page say
         * it twice to anyone querying for it. */}
        <p className="rating-chart__unrated-body">
          Unrated — finish a rated match to start your rating.
        </p>
      </div>
    </section>
  )
}
