import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useEffect } from 'react'
import { resultRefusal } from '../../api/errors'
import { approvalCheckQuery } from '../../api/queries'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { resultsOf, subscribeResults } from '../../scoring/results'
import { base64url } from '../../signing/text'

type Props = { matchId: string; envelope: Uint8Array<ArrayBuffer> }

// FortyMM's check of a result both players approved, which this device
// sends. The approval never waits on it, so while the check loads, fails
// with no network or can't go yet, the page still says the result is
// approved, under the check: on this device if the viewer just approved
// it, or by both players if they reopened a link their opponent approved.
// A refusal shows alone, so "approved" never sits above it.
export function ServerCheck({ approvedHere, ...props }: Props & { approvedHere: boolean }) {
  const { api } = useRouteContext({ from: '__root__' })
  // Reads the boundary's query without fetching it, so the notice can sit
  // outside the boundary and still show beside its error.
  const { data: verdict } = useQuery({ ...approvalCheckQuery(api, props.matchId, props.envelope), enabled: false })
  const onDevice = verdict?.kind !== 'refused' && verdict?.kind !== 'accepted'
  return (
    <>
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
      {onDevice && (
        <p className="fm-notice approval-status" role="status">
          <Icon name="check" />
          <span>{approvedHere ? 'Approved on this device' : 'Approved by both players'}</span>
        </p>
      )}
    </>
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
        <p className="fm-alert__title">FortyMM didn’t accept this result</p>
        <p className="fm-alert__body">{resultRefusal(verdict.title)}</p>
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
    <p className="fm-notice approval-status" role="status">
      <Icon name="check" />
      <span>Approved. FortyMM has the result.</span>
    </p>
  )
}
