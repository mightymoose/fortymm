import { useNavigate, useParams } from '@tanstack/react-router'
import { Button } from '../../components/Button'
import { useSingleSelect } from '../../components/singleSelect'
import {
  clearEverything,
  NETWORKS,
  resetMatch,
  setDemoNetwork,
  useDemoNetwork,
  type Network,
} from '../../scoring/demoServer'
import type { Match } from '../../scoring/demoMatches'
import { draftHash, nowSeconds } from '../../scoring/fragment'
import { PATH, ROUTE } from './sides'

const LABELS: Record<Network, string> = {
  normal: 'Normal',
  slow: 'Slow',
  flaky: 'Flaky',
  offline: 'Offline',
  broken: 'Broken',
}

// Tools for trying the background sync against the demo server: the
// network it answers on, and starting over. They go when the API has
// matches. Starting over keeps an API match's details in the fragment,
// because nothing else on the device knows them.
export function TestingPanel({ match }: { match: Match }) {
  const { matchId } = useParams({ from: ROUTE })
  const network = useDemoNetwork()
  const navigate = useNavigate()
  const startOver = (clear: () => void) => {
    clear()
    void navigate({
      to: PATH,
      params: { matchId, gameNumber: '1' },
      search: true,
      hash: draftHash(match, [], null, nowSeconds()),
      replace: true,
    })
  }

  return (
    <section className="score-testing" aria-labelledby="score-testing-title">
      <h2 className="score-testing__title" id="score-testing-title">
        Testing
      </h2>
      <NetworkPicker
        // Picks up a network that another tab or Clear everything sets.
        key={network}
        network={network}
      />
      <div className="score-testing__actions">
        <Button variant="secondary" size="sm" onClick={() => startOver(() => resetMatch(matchId))}>
          Reset match
        </Button>
        <Button variant="danger" size="sm" onClick={() => startOver(clearEverything)}>
          Clear everything
        </Button>
      </div>
      <p className="fm-help">
        Reset match empties this match’s games and its server copy. Clear everything empties every
        demo match’s server copy too.
      </p>
    </section>
  )
}

function NetworkPicker({ network }: { network: Network }) {
  const labels = NETWORKS.map((option) => LABELS[option])
  const { optionProps } = useSingleSelect(
    'radio',
    labels,
    (label) => setDemoNetwork(NETWORKS[labels.indexOf(label)]),
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
