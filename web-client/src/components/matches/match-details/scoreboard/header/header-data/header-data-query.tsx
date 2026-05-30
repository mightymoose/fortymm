import type { MatchDetails } from "@/api/matches";
import type { StatusView } from "@/components/matches/match-status-badge";
import { matchDetailsQuery } from "../../../match-details-query";

function toStatusView(data: MatchDetails): StatusView {
    switch (data.status) {
        case "in_progress":
            return data.current_game
                ? { kind: "live", gameNumber: data.current_game.game_number }
                : { kind: "awaiting-confirmation" };
        case "pending":
            return { kind: "upcoming", label: data.status_label };
        case "completed":
        case "disputed":
        case "voided":
            return { kind: "final" };
    }
}

export type HeaderSide = { id: string; username: string };
export type GameScore = { sideNumber: number; points: number };

function toSides(data: MatchDetails): HeaderSide[] {
    return [...data.sides]
        .sort((a, b) => a.side_number - b.side_number)
        .map((side) => ({
            id: side.players[0]?.user_id ?? "",
            username: side.players[0]?.username ?? "",
        }));
}

function toGames(data: MatchDetails): GameScore[][] {
    return data.games.flatMap((game) =>
        game.score
            ? [[
                  { sideNumber: 0, points: game.score.side_1_points },
                  { sideNumber: 1, points: game.score.side_2_points },
              ]]
            : [],
    );
}

export const headerDataQuery = (matchId: string) => ({
    ...matchDetailsQuery(matchId),
    select: (data: MatchDetails) => ({
        status: toStatusView(data),
        bestOf: data.best_of,
        sides: toSides(data),
        games: toGames(data),
    }),
});
