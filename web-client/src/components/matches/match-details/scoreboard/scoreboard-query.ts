import { matchQueryOptions } from '@/api/matches';
import type { Scoreboard } from '@/api/matches';

export type { Scoreboard };

const selectScoreboard = ({ data }: { data: { scoreboard: Scoreboard } }): Scoreboard =>
    data.scoreboard;

export const scoreboardQuery = (matchId: string) => ({
    ...matchQueryOptions(matchId),
    select: selectScoreboard,
});
