import { Card } from '../../components/Card'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { dayInSentence, dayLabel, opponentsOf, timeLabel, type Dashboard, type PlayerSummary, type RecentMatch, matchCountText } from './dashboard'
import { type AttentionCopy, useAttentionCopy } from './attention'
import { NewMatchLink, ResultText, Skeleton } from './parts'

// Option A, "Next step": one card with the single most useful thing to do,
// then the player's results as match rows, then the players they manage.
export function OptionA({ dashboard, now }: { dashboard: Dashboard; now: Date }) {
  const copy = useAttentionCopy()
  const [lead, ...rest] = dashboard.attention
  const { me } = dashboard

  return (
    <div className="dash dash-a">
      <header className="dash-a__head">
        <h1 className="dash__title">Hi, {me.player.display_name}</h1>
        <p className="meta">{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      </header>

      {lead ? (
        <LeadCard copy={copy(lead, 'lg')} />
      ) : (
        <Card
          title="Your next match"
          subtitle={me.last ? `Last played ${dayInSentence(me.last.played_at, now)}` : undefined}
          actions={dashboard.canCreateMatch ? <NewMatchLink size="lg" /> : undefined}
        >
          <p className="dash__body">Set up a match when you get to the table. Scoring works with no signal.</p>
        </Card>
      )}

      {rest.map((item) => {
        const { title, body } = copy(item)
        return (
          <p key={item.kind} className="fm-notice">
            <Icon name="info" />
            <span>
              <b>{title}.</b> {body}
            </span>
          </p>
        )
      })}

      <section aria-labelledby="dash-a-results">
        <div className="dash__section-head">
          <h2 className="h3" id="dash-a-results">
            Your results
          </h2>
          {me.player.match_count > 0 && <span className="meta">{matchCountText(me.player.match_count)} in all</span>}
        </div>
        {me.player.recent_matches.length > 0 ? (
          <div className="fm-matches">
            {me.player.recent_matches.map((match) => (
              <ResultRow key={match.id} match={match} name="You" now={now} />
            ))}
          </div>
        ) : (
          <EmptyState title="No matches yet">Log one after you play, and your results show here.</EmptyState>
        )}
      </section>

      {dashboard.managed.length > 0 && <Managed players={dashboard.managed} now={now} />}
    </div>
  )
}

function LeadCard({ copy: { title, body, action } }: { copy: AttentionCopy }) {
  return (
    <Card title={title} actions={action}>
      <p className="dash__body">{body}</p>
    </Card>
  )
}

// A finished match as a match row: the day and time, then each side with
// the games it won, the winner bold.
function ResultRow({ match, name, now }: { match: RecentMatch; name: string; now: Date }) {
  const opponent = opponentsOf(match)
  const result = match.result
  const mine = result ? result.games[0] : null
  const theirs = result ? result.games[1] : null
  const side = (who: string, games: number | null, won: boolean | null) => (
    <div className={`fm-match__p${won === null ? '' : won ? ' w' : ' l'}`}>
      <span className="fm-match__name">{who}</span>
      <span />
      <span className="fm-match__games">{games ?? '–'}</span>
    </div>
  )
  return (
    <article className="fm-match" data-state="final" aria-label={`You vs ${opponent}`}>
      <div className="fm-match__head">
        <span className="fm-status">{result ? 'Final' : 'No result yet'}</span>
        <span>
          {dayLabel(match.played_at, now)} · <span className="num">{timeLabel(match.played_at)}</span>
        </span>
      </div>
      {side(name, mine, result ? result.won : null)}
      {side(opponent, theirs, result ? !result.won : null)}
    </article>
  )
}

function Managed({ players, now }: { players: readonly PlayerSummary[]; now: Date }) {
  return (
    <section aria-labelledby="dash-a-managed">
      <h2 className="h3" id="dash-a-managed">
        Players you manage
      </h2>
      <ul className="fm-list fm-list--divided">
        {players.map(({ player, last }) => (
          <li key={player.id} className="dash-a__managed">
            <div>
              <p className="dash__name">{player.display_name}</p>
              <p className="meta">
                {matchCountText(player.match_count)}
                {last && <> · last played {dayInSentence(last.played_at, now)}</>}
              </p>
            </div>
            {player.open_question ? <span className="fm-status">Is this you?</span> : last && <ResultText match={last} />}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function OptionASkeleton() {
  return (
    <div className="dash dash-a" aria-hidden="true">
      <header className="dash-a__head">
        <Skeleton width={260} height={36} />
        <Skeleton width={140} height={14} />
      </header>
      <div className="fm-card">
        <Skeleton width={180} height={20} />
        <Skeleton width="80%" />
        <Skeleton width={140} height={44} />
      </div>
      <section>
        <Skeleton width={120} height={20} />
        {[0, 1, 2].map((row) => (
          <div key={row} className="dash-skel-row">
            <Skeleton width={160} height={13} />
            <Skeleton width="60%" height={20} />
            <Skeleton width="50%" height={20} />
          </div>
        ))}
      </section>
    </div>
  )
}
