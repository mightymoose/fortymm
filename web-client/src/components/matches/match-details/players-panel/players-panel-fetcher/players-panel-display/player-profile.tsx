import { cn } from "@/lib/utils";

import { CareerStats } from "./player-profile/career-stats";
import { type PlayerProfileView } from "../players-panel-query";
import { RatingBox } from "./player-profile/rating-box";
import { RecentForm } from "./player-profile/recent-form";

export interface PlayerProfileProps {
  profile: PlayerProfileView;
}

export const PlayerProfile = ({ profile }: PlayerProfileProps) => (
  <div className="md-profile">
    <div className="md-profile__identity">
      <div
        className={cn(
          "md-avatar",
          profile.won ? "md-avatar--win" : "md-avatar--loss",
        )}
      >
        {profile.initials}
      </div>
      <div className="md-profile__id-text">
        <div className="md-profile__name">{profile.name}</div>
      </div>
    </div>
    <RatingBox rating={profile.rating} />
    <RecentForm form={profile.form} />
    <CareerStats career={profile.career} />
  </div>
);
