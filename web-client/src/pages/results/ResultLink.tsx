import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useLocation } from '@tanstack/react-router'
import { DetailList } from '../../components/DetailList'
import { ErrorScreen } from '../../components/ErrorScreen'
import { QueryBoundary } from '../../components/QueryBoundary'
import { hex } from '../../signing/bytes'
import { Malformed } from '../../signing/cbor'
import { decodeEnvelope } from '../../signing/envelope'
import { decodePayload, resultHash } from '../../signing/result'
import { envelopeFromText, LINK_PREFIX } from '../../signing/text'

// What a result link holds, decoded from its fragment alone. It's a public
// page that makes no request, so it opens offline. It checks no signature.
export function ResultLink() {
  const { hash } = useLocation()
  const decoded = decode(hash)
  if (!decoded) {
    return (
      <ErrorScreen
        title="This link isn’t a FortyMM result"
        actions={
          <Link to="/" className="fm-btn fm-btn--primary">
            Go to FortyMM
          </Link>
        }
      >
        Its result is missing or damaged. Ask for the link again.
      </ErrorScreen>
    )
  }
  const { payload, signatures, issuedAt, result } = decoded
  return (
    <main className="page">
      <h1>Signed match result</h1>
      <p>Not validated. This page checks no signature.</p>
      <DetailList
        details={[
          { term: 'Match', value: result.match, numeric: true },
          { term: 'Best of', value: result.bestOf, numeric: true },
          { term: 'Rated', value: result.rated ? 'Yes' : 'No' },
          { term: 'Player 1', value: result.players[0], numeric: true },
          { term: 'Player 2', value: result.players[1], numeric: true },
          {
            term: 'Games',
            value: result.games.length
              ? result.games.map(([first, second]) => `${first}–${second}`).join(', ')
              : 'None',
            numeric: true,
          },
          {
            term: 'Ending',
            value:
              result.ending === 'completed'
                ? 'Completed'
                : `Retired by player ${result.retiredBy + 1}`,
          },
          { term: 'Replaces', value: result.replaces ? hex(result.replaces) : 'None', numeric: true },
          { term: 'Issued at', value: new Date(issuedAt * 1000).toISOString(), numeric: true },
          ...signatures.map(({ side, kid }, index) => ({
            term: `Signature ${index + 1}`,
            value: `Player ${side + 1}, key ${hex(kid)}`,
            numeric: true,
          })),
          {
            term: 'Result hash',
            value: (
              <QueryBoundary skeleton={<span className="fm-skeleton">…</span>}>
                <ResultHash payload={payload} />
              </QueryBoundary>
            ),
            numeric: true,
          },
        ]}
      />
    </main>
  )
}

function ResultHash({ payload }: { payload: Uint8Array<ArrayBuffer> }) {
  const { data } = useSuspenseQuery({
    queryKey: ['result-hash', hex(payload)],
    queryFn: async () => hex(await resultHash(payload)),
    staleTime: Infinity,
    networkMode: 'always',
  })
  return data
}

// The envelope and payload of a link's fragment, or null for anything that
// isn't a result in the format.
function decode(fragment: string) {
  try {
    const { payload, signatures } = decodeEnvelope(envelopeFromText(LINK_PREFIX + fragment))
    return { payload, signatures, ...decodePayload(payload) }
  } catch (error) {
    if (error instanceof Malformed) return null
    throw error
  }
}
