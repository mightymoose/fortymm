import { Button } from '../../components/Button'
import { Wordmark } from '../../components/Wordmark'
import { MatchPreview, type PreviewMatch, type PreviewVariant } from './MatchPreview'
import './adoption.css'

const NOW = new Date()
const MIN = 60_000
const DAY = 24 * 60 * MIN

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
}

function m(id: string, at: number, opponent: string, games?: [number, number]): PreviewMatch {
  return {
    id,
    played_at: ago(at),
    opponent,
    result: games ? { won: games[0] > games[1], games } : null,
  }
}

type State = { title: string; player: string; count: number; recent: PreviewMatch[] }

const STATES: Record<string, State> = {
  none: { title: 'No matches', player: 'mellow mongoose 594', count: 0, recent: [] },
  pending: {
    title: 'One match, no result yet',
    player: 'mellow mongoose 594',
    count: 1,
    recent: [m('p1', 12 * MIN, 'Sam')],
  },
  sam: {
    title: '3 matches today, last one against Sam',
    player: 'mellow mongoose 594',
    count: 3,
    recent: [m('s1', 25 * MIN, 'Sam', [3, 1]), m('s2', 70 * MIN, 'Priya Natarajan', [1, 3]), m('s3', 130 * MIN, 'Jordan Lee', [3, 0])],
  },
  mix: {
    title: 'Wins, losses and no result, over several days',
    player: 'mellow mongoose 594',
    count: 5,
    recent: [
      m('x1', 2 * DAY, 'Sam'),
      m('x2', 2 * DAY + 40 * MIN, 'Priya Natarajan', [3, 2]),
      m('x3', 3 * DAY, 'Jordan Lee', [0, 3]),
      m('x4', 4 * DAY, 'Alex Chen'),
      m('x5', 6 * DAY, 'Chen Wei', [3, 1]),
    ],
  },
  more: {
    title: 'More matches than the preview lists',
    player: 'mellow mongoose 594',
    count: 14,
    recent: [
      m('o1', 40 * MIN, 'Sam', [2, 3]),
      m('o2', DAY, 'Priya Natarajan', [3, 1]),
      m('o3', DAY + 30 * MIN, 'Jordan Lee'),
      m('o4', 3 * DAY, 'Alex Chen', [3, 0]),
      m('o5', 8 * DAY, 'Chen Wei', [1, 3]),
    ],
  },
  long: {
    title: 'Long player names',
    player: 'extraordinarily patient pangolin 8812',
    count: 3,
    recent: [
      m('l1', 30 * MIN, 'Wójcik-Szymańska, Agnieszka Maria-Theresa', [3, 2]),
      m('l2', DAY, 'Bartholomew Alexander Featherstonehaugh-Cholmondeley'),
      m('l3', 2 * DAY, 'Nguyễn Thị Minh Khai', [0, 3]),
    ],
  },
}

const VARIANTS: { id: PreviewVariant; label: string }[] = [
  { id: 'list', label: 'A · List' },
  { id: 'rows', label: 'B · Match rows' },
  { id: 'last', label: 'C · Last match' },
]

const WIDTHS = [
  { label: 'Phone 390', width: 390, height: 760 },
  { label: 'Desktop 1024', width: 1024, height: 760 },
]

// Throwaway: the "Is this you?" preview on fake data, for design review.
// `?frame=<state>&variant=<id>` renders one review page; no params renders
// the gallery of every state at both widths.
export function PreviewDemo() {
  const params = new URLSearchParams(window.location.search)
  const variant = (params.get('variant') as PreviewVariant | null) ?? 'list'
  const frame = params.get('frame')
  if (frame && STATES[frame]) return <Frame state={STATES[frame]} variant={variant} />
  return (
    <div style={{ padding: 'var(--s-6) var(--s-4)', background: 'var(--bg-app)', minHeight: '100dvh' }}>
      <h1 className="h2" style={{ margin: 0 }}>
        “Is this you?” match preview · fake data
      </h1>
      <div className="fm-seg" role="group" aria-label="Variant" style={{ margin: 'var(--s-4) 0 var(--s-6)' }}>
        {VARIANTS.map((v) => (
          <a
            key={v.id}
            href={`?variant=${v.id}`}
            className={v.id === variant ? 'fm-btn fm-btn--primary fm-btn--sm' : 'fm-btn fm-btn--secondary fm-btn--sm'}
            style={{ marginRight: 'var(--s-2)' }}
          >
            {v.label}
          </a>
        ))}
      </div>
      {Object.entries(STATES).map(([id, state]) => (
        <section key={id} id={id} style={{ marginBottom: 'var(--s-12)' }}>
          <h2 className="h3" style={{ margin: '0 0 var(--s-3)' }}>
            {state.title}
          </h2>
          <div style={{ display: 'flex', gap: 'var(--s-6)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {WIDTHS.map((w) => (
              <figure key={w.width} style={{ margin: 0 }}>
                <figcaption style={{ font: '500 13px var(--font-ui)', color: 'var(--fg-3)', marginBottom: 'var(--s-2)' }}>
                  {w.label}
                </figcaption>
                <iframe
                  title={`${state.title}, ${w.label}`}
                  src={`?frame=${id}&variant=${variant}`}
                  width={w.width}
                  height={w.height}
                  style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', maxWidth: '100%' }}
                />
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function Frame({ state, variant }: { state: State; variant: PreviewVariant }) {
  return (
    <div className="review">
      <header className="review-top">
        <Wordmark />
      </header>
      <main className="review-content">
        <h1 className="h2 review-q">Is this you?</h1>
        <p className="review-playedas">
          <b>{state.player}</b> was used before you signed in.
        </p>
        <MatchPreview player={state.player} count={state.count} recent={state.recent} variant={variant} now={NOW} />
      </main>
      <div className="review-actions" role="group" aria-label="Your answer">
        <Button variant="primary" size="lg">
          Yes, this is me
        </Button>
        <Button variant="secondary" size="lg">
          Someone else played
        </Button>
      </div>
    </div>
  )
}
