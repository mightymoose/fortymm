import { useSuspenseQuery } from "@tanstack/react-query";
import { headerDataQuery } from "./header-data/header-data-query";
import { MatchHeaderDataDisplay } from "./header-data/header-data-display";

interface HeaderDataProps {
  matchId: string;
}

export const HeaderData = ({ matchId }: HeaderDataProps) => {
    const { data: matchHeaderData } = useSuspenseQuery(headerDataQuery(matchId));

    return <MatchHeaderDataDisplay matchHeaderData={matchHeaderData} />
};