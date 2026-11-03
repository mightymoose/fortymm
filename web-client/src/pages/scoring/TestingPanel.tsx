import { useLoaderData, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Button } from '../../components/Button'
import { useSingleSelect } from '../../components/singleSelect'
import { clearEverything, NETWORKS, parseNetwork, resetMatch, type Network } from '../../scoring/demoServer'

const ROUTE = '/_authenticated/matches/$matchId/scores/game/$gameNumber/edit'

const LABELS: Record<Network, string> = {
  normal: 'Normal',
  slow: 'Slow',
  flaky: 'Flaky',
  offline: 'Offline',
  broken: 'Broken',
}

// Tools for trying the scratchpad against the demo server: the network it
// answers on, and starting over. They go when the API has matches.
export function TestingPanel() {
  const { matchId } = useParams({ from: ROUTE })
  const { gameNumber } = useLoaderData({ from: ROUTE })
  const network = parseNetwork(useSearch({ from: ROUTE }).network)
  const navigate = useNavigate()
  const goTo = (game: number, next: Network) =>
    navigate({
      to: '/matches/$matchId/scores/game/$gameNumber/edit',
      params: { matchId, gameNumber: String(game) },
      search: next === 'normal' ? {} : { network: next },
      replace: true,
    })

  return (
    <section className="score-testing" aria-labelledby="score-testing-title">
      <h2 className="score-testing__title" id="score-testing-title">
        Testing
      </h2>
      <NetworkPicker
        // Picks up a network that the URL changes.
        key={network}
        network={network}
        onChange={(next) => void goTo(gameNumber, next)}
      />
      <div className="score-testing__actions">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            resetMatch(matchId)
            void goTo(1, network)
          }}
        >
          Reset match
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            clearEverything()
            void goTo(1, network)
          }}
        >
          Clear everything
        </Button>
      </div>
      <p className="fm-help">
        Reset match empties this match’s games and its server copy. Clear everything does that for
        every demo match.
      </p>
    </section>
  )
}

function NetworkPicker({ network, onChange }: { network: Network; onChange: (network: Network) => void }) {
  const labels = NETWORKS.map((option) => LABELS[option])
  const { optionProps } = useSingleSelect(
    'radio',
    labels,
    (label) => onChange(NETWORKS[labels.indexOf(label)]),
    NETWORKS.indexOf(network),
  )
  return (
    <div className="score-testing__network">
      <span className="fm-label" id="score-testing-network">
        Network
      </span>
      <div className="fm-seg" role="radiogroup" aria-labelledby="score-testing-network">
        {labels.map((label, index) => (
          <button key={label} type="button" role="radio" {...optionProps(index)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
