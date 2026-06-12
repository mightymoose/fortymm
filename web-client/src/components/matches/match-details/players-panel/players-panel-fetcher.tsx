import { useSuspenseQuery } from "@tanstack/react-query";

import { PlayersPanelDisplay } from "./players-panel-fetcher/players-panel-display";
import { playersPanelQuery } from "./players-panel-fetcher/players-panel-query";

export interface PlayersPanelProps {
  matchId: string;
}

export function PlayersPanelFetcher({ matchId }: PlayersPanelProps) {
  const { data: panel } = useSuspenseQuery(playersPanelQuery(matchId));

  return <PlayersPanelDisplay panel={panel} />;
}
