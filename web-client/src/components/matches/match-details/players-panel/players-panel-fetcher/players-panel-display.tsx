import { useId } from "react";

import { Overline } from "@/components/overline";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";

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
          {/* Caption treatment is kept byte-identical to the head-to-head
              panel's `CardAction` — same size, tracking, and the `--fg-muted`
              grey both captions shipped with. `text-muted-foreground` is NOT
              the same colour here: `.fortymm-theme` remaps it to the lighter
              `--chalk-300`. */}
          <CardAction className="self-center text-[11px] font-medium tracking-[0.08em] text-[color:var(--fg-muted)]">
            {panel.snapshotLabel}
          </CardAction>
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
