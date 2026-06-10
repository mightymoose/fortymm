import { Fragment, useId } from "react";

import { Overline } from "@/components/overline";

import { RatingRow } from "./rating-row";
import { type RatingsView } from "./ratings-query";

export interface RatingsDisplayProps {
  ratings: RatingsView;
}

export const RatingsDisplay = ({ ratings }: RatingsDisplayProps) => {
  const id = useId();

  return (
    <section className="md-card" aria-labelledby={id}>
      <div className="md-card__hd">
        <Overline as="h3" id={id}>
          Result · rating change
        </Overline>
      </div>
      <div className="md-card__body md-rating-card__body">
        {ratings.rows.map((row, i) => (
          <Fragment key={row.username}>
            {i > 0 && <hr className="md-rating-divider" />}
            <RatingRow row={row} />
          </Fragment>
        ))}
      </div>
    </section>
  );
};
