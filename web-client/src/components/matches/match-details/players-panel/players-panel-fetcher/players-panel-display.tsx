import { useId } from "react";

import { Overline } from "@/components/overline";

import { NoOpponentProfile } from "./players-panel-display/no-opponent-profile";
import { PlayerProfile } from "./players-panel-display/player-profile";
import { type PlayersPanelView } from "./players-panel-query";

export interface PlayersPanelDisplayProps {
  panel: PlayersPanelView;
}

export const PlayersPanelDisplay = ({ panel }: PlayersPanelDisplayProps) => {
  const id = useId();

  return (
    <section className="md-card" aria-labelledby={id}>
      <div className="md-card__hd">
        <Overline as="h3" id={id}>
          Players · going into this match
        </Overline>
        <span className="md-card__hd-meta">{panel.snapshotLabel}</span>
      </div>
      <div className="md-players">
        {panel.left ? (
          <PlayerProfile profile={panel.left} />
        ) : (
          <NoOpponentProfile />
        )}
        <div className="md-players__divider" />
        {panel.right ? (
          <PlayerProfile profile={panel.right} />
        ) : (
          <NoOpponentProfile />
        )}
      </div>
    </section>
  );
};
