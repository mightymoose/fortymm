import type { StatusView } from "@/components/matches/match-status-badge";
import type { GameScore, HeaderSide } from "./header-data-query";
import { Meta } from "./header-data-display/meta";
import { MatchScore } from "./header-data-display/match-score";

export interface MatchHeaderData {
    status: StatusView;
    bestOf: number;
    sides: HeaderSide[];
    games: GameScore[][];
}

export interface MatchHeaderDataDisplayProps {
    matchHeaderData: MatchHeaderData;
}

export const MatchHeaderDataDisplay = ({ matchHeaderData }: MatchHeaderDataDisplayProps) => {
    return <div>
        <Meta status={matchHeaderData.status} bestOf={matchHeaderData.bestOf} />
        <MatchScore status={matchHeaderData.status} sides={matchHeaderData.sides} games={matchHeaderData.games} bestOf={matchHeaderData.bestOf} />
    </div>
}