export interface PlayerScoreProps {
  label: string
  score: number
  won: boolean
  className?: string
}

export const PlayerScore = ({
  label,
  score,
  won,
  className,
}: PlayerScoreProps) => (
  <div className={className} aria-label={label} data-won={won || undefined}>
    {score}
    {won && <span className="sr-only">, winner</span>}
  </div>
)
