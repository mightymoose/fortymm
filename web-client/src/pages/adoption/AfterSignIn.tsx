import { useSuspenseQuery } from '@tanstack/react-query'
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { useEffect, useEffectEvent } from 'react'
import { accountPlayersQuery, sessionQuery } from '../../api/queries'
import { QueryBoundary } from '../../components/QueryBoundary'

// Home renders this when the URL has `signed_in=1`. It opens "Is this you?"
// if the sign-in brought an open question, or else drops the param. A guest
// has no questions, so it asks for no players.
export function AfterSignIn() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  // A guest keeps the param. After a slow sign-in the session can show the
  // saved guest account first, and the verified one replaces it later.
  if (account.kind !== 'verified') return null
  return (
    // It renders nothing, so a skeleton would push the roadmap down while
    // the players load, then pull it back up.
    <QueryBoundary skeleton={null}>
      <OpenQuestionRedirect />
    </QueryBoundary>
  )
}

function OpenQuestionRedirect() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: players } = useSuspenseQuery(accountPlayersQuery(api))
  const navigate = useNavigate()
  const hasOpenQuestion = players.some((player) => player.open_question)

  // Both replace the URL, so a reload or Back after a sign-in doesn't open
  // the review again.
  const redirect = useEffectEvent(() => {
    if (hasOpenQuestion) void navigate({ to: '/review-players', replace: true })
    else void navigate({ to: '/', search: {}, replace: true })
  })
  useEffect(() => redirect(), [])

  return null
}
