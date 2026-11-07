import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useEffect } from 'react'
import { approvalCheckQuery } from '../../api/queries'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { resultsOf, subscribeResults } from '../../scoring/results'
import { base64url } from '../../signing/text'

type Props = { matchId: string; envelope: Uint8Array<ArrayBuffer> }

// FortyMM's check of an approved result, under "Approved on this device".
// The approval never waits on it, so with no network the page still says
// the result is approved, and the check shows Try again.
export function ServerCheck(props: Props) {
  return (
    <QueryBoundary
      skeleton={
        <p className="fm-notice" aria-busy="true">
          <span className="fm-skeleton server-check-skeleton" />
          <span className="fm-sr">Checking with FortyMM</span>
        </p>
      }
    >
      <Verdict {...props} />
    </QueryBoundary>
  )
}

function Verdict({ matchId, envelope }: Props) {
  const { api } = useRouteContext({ from: '__root__' })
  const queryClient = useQueryClient()
  const { data: verdict } = useSuspenseQuery(approvalCheckQuery(api, matchId, envelope))
  // A waiting approval checks again once the outbox has sent it.
  const waiting = verdict.kind === 'waiting'
  useEffect(() => {
    if (!waiting) return
    const text = base64url(envelope)
    const { queryKey } = approvalCheckQuery(api, matchId, envelope)
    const checkIfSent = () => {
      if (!resultsOf(matchId).includes(text)) void queryClient.invalidateQueries({ queryKey })
    }
    checkIfSent()
    return subscribeResults(checkIfSent)
  }, [waiting, api, matchId, envelope, queryClient])
  if (verdict.kind === 'refused') {
    return (
      <div className="fm-alert fm-alert--error" role="alert">
        <Icon name="error" />
        <p className="fm-alert__title">FortyMM refused this result</p>
        <p className="fm-alert__body">{verdict.title}</p>
      </div>
    )
  }
  if (verdict.kind === 'waiting') {
    return (
      <p className="fm-notice" role="status">
        <Icon name="clock" />
        <span>FortyMM can’t take it yet, so this device keeps sending it</span>
      </p>
    )
  }
  return (
    <p className="fm-notice" role="status">
      <Icon name="check" />
      <span>FortyMM checked the signatures and the scores</span>
    </p>
  )
}
