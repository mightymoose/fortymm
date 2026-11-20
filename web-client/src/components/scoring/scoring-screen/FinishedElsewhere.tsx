import { Link, type LinkOptions } from '@tanstack/react-router'
import { Alert } from '../../Alert.tsx'
import { buttonClassName } from '../../button-class.ts'

// The notice for an empty game whose match was finished elsewhere (another
// tab, later a sync pull) since its page opened: the person can't do what
// they came to do, so it is a warning alert, unlike the scoreline's fading
// tint for other changes. Save is off meanwhile (ScoringScreen); what is
// typed stays. Its one action goes to the match's page. Approved by the
// user as built (2026-11-18).
export function FinishedElsewhere({
  game,
  matchPage,
}: {
  game: number
  matchPage: LinkOptions
}) {
  return (
    <Alert
      tone="warning"
      title="This match was finished since you opened this page."
      actions={
        <Link {...matchPage} className={buttonClassName({ variant: 'secondary', size: 'sm' })}>
          Go to the match
        </Link>
      }
    >
      Game {game} can’t be played, so this score can’t be saved.
    </Alert>
  )
}
