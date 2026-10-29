import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useRouteContext, useSearch } from '@tanstack/react-router'
import { useEffect, useEffectEvent } from 'react'
import { accountPlayersQuery, sessionQuery, type AccountPlayer } from '../../api/queries'
import { Icon } from '../../components/Icon'
import './adoption.css'

// The reminder on Home of the players a sign-in brought to the account that
// still wait for "Is this you?". Its link opens the review. Right after a
// sign-in, Home goes straight to the review instead.
export function AdoptionReview() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useQuery(sessionQuery(api))
  const { data: players } = useQuery({
    ...accountPlayersQuery(api),
    enabled: account?.kind === 'verified',
  })
  const { signed_in: signedIn } = useSearch({ from: '/_authenticated/_shell/' })
  const navigate = useNavigate()

  const open = players?.filter((player) => player.open_question) ?? []

  // Both replace the URL, so a reload or Back after a sign-in shows only the
  // reminder.
  const afterSignIn = useEffectEvent(() => {
    if (open.length > 0) void navigate({ to: '/review-players', replace: true })
    else void navigate({ to: '/', search: {}, replace: true })
  })
  const loaded = players !== undefined
  useEffect(() => {
    if (signedIn && loaded) afterSignIn()
  }, [signedIn, loaded])

  if (open.length === 0) return null
  return (
    <div className="adopt">
      <Reminder open={open} />
    </div>
  )
}

function Reminder({ open }: { open: readonly AccountPlayer[] }) {
  const one = open.length === 1
  return (
    <div className="fm-alert">
      <Icon name="info" />
      <p className="fm-alert__title">
        {one ? '1 player to review' : `${open.length} players to review`}
      </p>
      <p className="fm-alert__body">
        {one
          ? `${open[0].display_name} was used on this device before you signed in. Choose whether it belongs on your account.`
          : 'These players were used on this device before you signed in. Choose which belong on your account.'}
      </p>
      <div className="fm-alert__actions">
        <Link to="/review-players" className="fm-btn fm-btn--primary">
          {one ? 'Review player' : 'Review players'}
        </Link>
      </div>
    </div>
  )
}
