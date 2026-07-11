import { Fragment, useId } from "react";

import { Overline } from "@/components/overline";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

import { RatingRow } from "./ratings-display/rating-row";
import { type RatingsView } from "./ratings-query";

export interface RatingsDisplayProps {
  ratings: RatingsView;
}

export const RatingsDisplay = ({ ratings }: RatingsDisplayProps) => {
  const id = useId();

  return (
    // `asChild` keeps the panel a labelled landmark `<section>` while taking the
    // shared design-system card chrome (hairline ring, no rule under the title)
    // instead of the hand-rolled `.md-card` family.
    <Card asChild>
      <section aria-labelledby={id}>
        <CardHeader>
          <Overline as="h3" id={id}>
            Result · rating change
          </Overline>
        </CardHeader>
        {/* `md-rating-card__body` is content layout (the column gap between
            players), not card chrome — it stays. */}
        <CardContent className="md-rating-card__body">
          {ratings.rows.map((row, i) => (
            <Fragment key={row.username}>
              {i > 0 && <hr className="md-rating-divider" />}
              <RatingRow row={row} />
            </Fragment>
          ))}
        </CardContent>
      </section>
    </Card>
  );
};
