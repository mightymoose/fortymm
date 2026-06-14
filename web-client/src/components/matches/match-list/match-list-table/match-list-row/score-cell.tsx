export interface ScoreCellView {
  /** Null when the score should read as pending ('—'): status not
   * in_progress/completed, or there is no second side. Otherwise the 'a–b'
   * games-won string. */
  games: string | null;
}

export interface ScoreCellProps {
  score: ScoreCellView;
}

export const ScoreCell = ({ score }: ScoreCellProps) => {
  if (score.games === null) {
    return <span className="score-cell pending">—</span>;
  }
  return <span className="score-cell games">{score.games}</span>;
};
