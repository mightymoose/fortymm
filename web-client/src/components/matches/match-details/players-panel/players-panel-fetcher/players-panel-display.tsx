import { useId } from "react";

import { Overline } from "@/components/overline";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

import { CardMeta } from "../../card-meta";

import { NoOpponentProfile } from "./players-panel-display/no-opponent-profile";
import { PlayerProfile } from "./players-panel-display/player-profile";
import { type PlayersPanelView } from "./players-panel-query";

export interface PlayersPanelDisplayProps {
  panel: PlayersPanelView;
}

/**
 * The "Players · going into this match" snapshot panel. Chrome is the shared
 * design-system `Card` (#218) — `asChild` keeps it a `<section>` labelled by
 * its own heading rather than an anonymous `<div>`. `CardContent` drops its
 * horizontal padding: `.md-players` is a full-bleed `1fr 1px 1fr` grid whose
 * `.md-profile` halves supply their own padding, and its divider is meant to
 * run edge to edge.
 */
export const PlayersPanelDisplay = ({ panel }: PlayersPanelDisplayProps) => {
  const id = useId();

  return (
    <Card asChild>
      <section aria-labelledby={id}>
        <CardHeader>
          <Overline as="h3" id={id}>
            Players · going into this match
          </Overline>
          <CardMeta>{panel.snapshotLabel}</CardMeta>
        </CardHeader>
        <CardContent className="md-players px-0">
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
        </CardContent>
      </section>
    </Card>
  );
};
