import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Header } from "./scoreboard/header";
import { LineScore } from "./scoreboard/line-score";

interface MatchViewProps {
    matchId: string;
}

export const Scoreboard = ({ matchId }: MatchViewProps) => (
  <Card>
    <CardHeader>
      <Header matchId={matchId} />
    </CardHeader>
    <CardContent className="flex flex-col gap-6">
      <LineScore matchId={matchId} />
    </CardContent>
  </Card>
);
