import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate, useRouteContext, useSearch } from '@tanstack/react-router'
import { useEffect, useEffectEvent, type Ref } from 'react'
import { accountPlayersQuery, sessionQuery, type AccountPlayer } from '../../api/queries'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import './adoption.css'

// The reminder on Home of the players a sign-in brought to the account that
// still wait for "Is this you?". Its link opens the review. Right after a
// sign-in, Home goes straight to the review instead. A guest has no
// questions, so it asks for no players.
export function AdoptionReview({ linkRef }: { linkRef?: Ref<HTMLAnchorElement> }) {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  if (account.kind !== 'verified') return null
  return (
    // Most accounts have no reminder, so a skeleton would push the roadmap
    // down while the players load, then pull it back up.
    <QueryBoundary skeleton={null}>
      <OpenQuestions linkRef={linkRef} />
    </QueryBoundary>
  )
}

function OpenQuestions({ linkRef }: { linkRef?: Ref<HTMLAnchorElement> }) {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: players } = useSuspenseQuery(accountPlayersQuery(api))
  const { signed_in: signedIn } = useSearch({ from: '/_authenticated/_shell/' })
  const navigate = useNavigate()

  const open = players.filter((player) => player.open_question)

  // Both replace the URL, so a reload or Back after a sign-in shows only the
  // reminder.
  const afterSignIn = useEffectEvent(() => {
    if (open.length > 0) void navigate({ to: '/review-players', replace: true })
    else void navigate({ to: '/', search: {}, replace: true })
  })
  useEffect(() => {
    if (signedIn) afterSignIn()
  }, [signedIn])

  if (open.length === 0) return null
  return (
    <div className="adopt">
      <Reminder open={open} linkRef={linkRef} />
    </div>
  )
}

function Reminder({
  open,
  linkRef,
}: {
  open: readonly AccountPlayer[]
  linkRef?: Ref<HTMLAnchorElement>
}) {
  const one = open.length === 1
  return (
    <div className="fm-alert">
      <Icon name="info" />
      <p className="fm-alert__title">
        {one ? '1 player to review' : `${open.length} players to review`}
      </p>
      <p className="fm-alert__body">
        {one
          ? `${open[0].display_name} was used before you signed in. Choose whether it belongs on your account.`
          : 'These players were used before you signed in. Choose which belong on your account.'}
      </p>
      <div className="fm-alert__actions">
        <Link to="/review-players" className="fm-btn fm-btn--primary" ref={linkRef}>
          {one ? 'Review player' : 'Review players'}
        </Link>
      </div>
    </div>
  )
}
