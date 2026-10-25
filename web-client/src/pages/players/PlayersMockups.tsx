import { Link } from '@tanstack/react-router'
import { Icon } from '../../components/Icon'
import { variants } from './variants'
import { variantSlugs } from './variantSlugs'

// The index of the players mockups: one link to each list, and one to a
// player who doesn't exist.
export function PlayersMockups() {
  return (
    <section className="players">
      <header className="players-head">
        <span className="doc-vo">Mockup · sample players, nothing is saved</span>
        <h1>Players</h1>
        <p>
          Five ways to show the players on FortyMM, each with its player page. The bar
          over each mockup switches between its states: loading, empty, errors and the
          missing player.
        </p>
      </header>
      <ul className="fm-list fm-list--divided mockup-index">
        {variantSlugs.map((slug) => (
          <li key={slug}>
            <Link to="/players/$variant" params={{ variant: slug }} className="player-row player-row--link">
              <span className="player-row__text">
                <b>{variants[slug].name}</b>
                <small>{variants[slug].summary}</small>
              </span>
              <Icon name="right" />
            </Link>
          </li>
        ))}
      </ul>
      <p className="fm-notice">
        <Icon name="info" />
        <span>
          A player who doesn’t exist shows the player 404 in each mockup, such as{' '}
          <Link to="/players/$variant/$playerId" params={{ variant: 'table', playerId: 'nobody' }}>
            this one
          </Link>
          .
        </span>
      </p>
    </section>
  )
}
