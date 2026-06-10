import { type RatingBoxView } from "./players-panel-query";
import { Sparkline } from "./sparkline";

export interface RatingBoxProps {
  rating: RatingBoxView;
}

export const RatingBox = ({ rating }: RatingBoxProps) => (
  <div className="md-profile__rating-box">
    <div>
      <div className="md-kicker">Rating</div>
      <div className="md-profile__rating-value">
        {rating.value ?? <span className="dim">Unrated</span>}
      </div>
    </div>
    {rating.sparkline && <Sparkline data={rating.sparkline} />}
  </div>
);
