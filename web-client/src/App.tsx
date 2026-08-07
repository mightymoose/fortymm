import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Wordmark } from '@/components/wordmark'
import { TESTFLIGHT_URL } from '@/lib/external-links'
import './landing.css'

/** Public source repository — FortyMM is GPLv3 and open to contributors. */
const GITHUB_URL = 'https://github.com/mightymoose/fortymm'

function App() {
  return (
    <div className="fortymm-theme fortymm-landing">
      <Nav />
      <Hero />
      <Features />
      <TournamentsBand />
      <Manifesto />
      <FAQ />
      <CtaBand />
      <Footer />
    </div>
  )
}

export default App

/* ------------------------------------------------------------------ */
/*  Nav                                                               */
/* ------------------------------------------------------------------ */
function Nav() {
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)

  const sectionLinks = (
    <>
      <a className="nav-link" href="#product" onClick={closeMenu}>Product</a>
      <a className="nav-link" href="#tournaments" onClick={closeMenu}>Tournaments</a>
      <a className="nav-link" href="#manifesto" onClick={closeMenu}>Manifesto</a>
      <a className="nav-link" href="#faq" onClick={closeMenu}>FAQ</a>
    </>
  )

  return (
    <nav className={`nav ${menuOpen ? 'is-open' : ''}`}>
      <Wordmark size={26} />
      <div className="nav-links">{sectionLinks}</div>
      <div style={{ flex: 1 }} />
      <Link
        className="nav-link nav-signin"
        to="/login"
        search={{ error: undefined, email: undefined }}
      >
        Sign in
      </Link>
      <Link className="btn btn-primary nav-cta" to="/matches/new">
        <span className="btn-dot" />
        Start playing
      </Link>
      <button
        type="button"
        className="nav-toggle"
        aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={menuOpen}
        aria-controls="nav-mobile-menu"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className="nav-toggle-bar" />
        <span className="nav-toggle-bar" />
        <span className="nav-toggle-bar" />
      </button>

      {menuOpen && (
        <div id="nav-mobile-menu" className="nav-mobile-menu">
          {sectionLinks}
          <Link
            className="nav-link"
            to="/login"
            search={{ error: undefined, email: undefined }}
            onClick={closeMenu}
          >
            Sign in
          </Link>
          <Link
            className="btn btn-primary nav-mobile-cta"
            to="/matches/new"
            onClick={closeMenu}
          >
            <span className="btn-dot" />
            Start playing
          </Link>
        </div>
      )}
    </nav>
  )
}

/* ------------------------------------------------------------------ */
/*  Hero                                                              */
/* ------------------------------------------------------------------ */
function Hero() {
  return (
    <section className="hero">
      <div className="fortymm-grid-bg hero-grid" />
      <div className="hero-halo" />

      <div className="hero-inner">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="ball-dot" />
            <span>No ads · No tracking · No subscriptions, ever</span>
          </div>

          <h1 className="hero-h1 display">
            Play more.<br />
            <span className="accent">Pay never.</span>
          </h1>

          <p className="hero-lede">
            FortyMM is a table-tennis match tracker and tournament platform —
            made by players, for players. It runs in your browser. No download,
            no sign-up. When you want a real account, just add an email.
          </p>

          <div className="hero-ctas">
            <Link className="btn btn-primary btn-lg" to="/matches/new">
              <span className="btn-dot" />
              Start a match in your browser
            </Link>
            <a className="btn btn-secondary btn-lg" href="#tournaments">
              Run a tournament →
            </a>
          </div>

          <div className="hero-meta">
            <span className="meta-item">
              <span className="meta-ico">
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <rect x="2" y="3" width="12" height="10" rx="2" />
                  <path d="M2 7h12" />
                </svg>
              </span>
              Web. iOS &amp; Android soon.
            </span>
            <span className="meta-divider" />
            <span className="meta-item">
              <span className="meta-ico">
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M8 1.5l2 4.5 5 .5-3.7 3.3L12.5 15 8 12.3 3.5 15l1.2-5.2L1 6.5l5-.5z" />
                </svg>
              </span>
              Open source. GPLv3.
            </span>
          </div>
        </div>

        <HeroScoreboard />
      </div>

      <HeroStatsStrip />
    </section>
  )
}

function HeroStatsStrip() {
  return (
    <div className="stats-strip">
      <div className="stats-strip-inner">
        <Stat n="12,480" l="matches logged" />
        <Stat n="340" l="clubs worldwide" />
        <Stat n="1,102" l="tournaments run" />
        <Stat n="0" l="dollars charged" highlight />
      </div>
    </div>
  )
}

function Stat({ n, l, highlight }: { n: string; l: string; highlight?: boolean }) {
  return (
    <div className="stat">
      <div className={`stat-n ${highlight ? 'stat-n--accent' : ''}`}>{n}</div>
      <div className="stat-l">{l}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Live Scoreboard                                                   */
/* ------------------------------------------------------------------ */
function HeroScoreboard() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2600)
    return () => clearInterval(id)
  }, [])

  const seq: Array<[number, number]> = [
    [8, 8], [9, 8], [9, 9], [10, 9], [10, 10], [11, 10], [11, 11], [12, 11],
  ]
  const [a, b] = seq[tick % seq.length]
  const aServ = tick % 4 < 2

  return (
    <div className="scoreboard">
      <div className="sb-chrome">
        <div className="sb-live">
          <span className="ball-dot ball-dot--live" />
          <span className="sb-live-label">LIVE · GAME 4 · BO5</span>
        </div>
        <div className="sb-meta">COURT 3 · 19:42</div>
      </div>

      <SbPlayer
        name="Nguyen, T."
        code="NGU"
        seed="1"
        rating="2145"
        score={a}
        winning={a > b}
        serving={aServ}
      />
      <div className="sb-divider" />
      <SbPlayer
        name="Okafor, D."
        code="OKA"
        seed="8"
        rating="1988"
        score={b}
        winning={b > a}
        serving={!aServ}
      />

      <div className="sb-games">
        {([[11, 6], [9, 11], [11, 8], [a, b]] as Array<[number, number]>).map(
          (g, i) => (
            <GameBox key={i} g={g} live={i === 3} label={`G${i + 1}`} />
          ),
        )}
      </div>

      <div className="sb-foot">
        <span className="sb-foot-item">
          <span className="sb-pip" /> Sets 2–1
        </span>
        <span className="sb-foot-item">
          Next: <span className="mono">+8 rating</span> on win
        </span>
        <span className="sb-share">Share →</span>
      </div>
    </div>
  )
}

function SbPlayer({
  name,
  code,
  seed,
  rating,
  score,
  winning,
  serving,
}: {
  name: string
  code: string
  seed: string
  rating: string
  score: number
  winning: boolean
  serving: boolean
}) {
  return (
    <div className={`sb-player ${winning ? 'is-winning' : ''}`}>
      <div className={`sb-avatar ${winning ? 'is-winning' : ''}`}>
        {code.slice(0, 2)}
      </div>
      <div className="sb-ident">
        <div className="sb-name">
          {name}
          {serving && (
            <span className="sb-serve" title="Serving">
              ●
            </span>
          )}
        </div>
        <div className="sb-sub">
          <span className="mono">SEED {seed}</span>
          <span className="sep">·</span>
          <span className="mono">{rating}</span>
        </div>
      </div>
      <div className={`sb-score ${winning ? 'is-winning' : ''}`}>
        {String(score)
          .padStart(2, '0')
          .split('')
          .map((d, i) => (
            <span key={i} className="sb-digit">
              {d}
            </span>
          ))}
      </div>
    </div>
  )
}

function GameBox({
  g,
  live,
  label,
}: {
  g: [number, number]
  live: boolean
  label: string
}) {
  return (
    <div className={`gamebox ${live ? 'is-live' : ''}`}>
      <div className="gb-label">{label}</div>
      <div className={`gb-score ${g[0] > g[1] ? 'is-win' : ''}`}>{g[0]}</div>
      <div className="gb-rule" />
      <div className={`gb-score ${g[1] > g[0] ? 'is-win' : ''}`}>{g[1]}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Features                                                          */
/* ------------------------------------------------------------------ */
type FeatureTab = 'track' | 'rate' | 'run' | 'watch'

function Features() {
  const [active, setActive] = useState<FeatureTab>('track')
  const tabs: Array<{ id: FeatureTab; label: string }> = [
    { id: 'track', label: 'Track matches' },
    { id: 'rate', label: 'See your ratings' },
    { id: 'run', label: 'Run tournaments' },
    { id: 'watch', label: 'Spectator view' },
  ]

  return (
    <section id="product" className="features">
      <div className="section-inner">
        <div className="section-head">
          <div className="eyebrow">
            <span className="ball-dot" />
            The product
          </div>
          <h2 className="section-h2 display">
            Everything a club needs.
            <br />
            <span className="muted">Nothing anyone would try to sell you.</span>
          </h2>
        </div>

        <div className="feat-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={active === t.id}
              className={`feat-tab ${active === t.id ? 'is-active' : ''}`}
              onClick={() => setActive(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="feat-stage">
          {active === 'track' && <FeatTrack />}
          {active === 'rate' && <FeatRate />}
          {active === 'run' && <FeatRun />}
          {active === 'watch' && <FeatWatch />}
        </div>

        <div className="feat-grid">
          <FeatBullet
            n="01"
            t="Match log"
            d="Tap in scores. Games auto-advance. Rating delta shows up the moment you save."
          />
          <FeatBullet
            n="02"
            t="Clubs & ladders"
            d="Every club gets a feed, a ladder, and a challenge board. Set it up in a minute."
          />
          <FeatBullet
            n="03"
            t="Schedules that actually work"
            d="Constraints in, schedule out — fewer back-to-backs, smarter court assignments."
          />
          <FeatBullet
            n="04"
            t="Ephemeral accounts"
            d="You get an account when you start playing. Upgrade it to a real one by adding an email — whenever."
          />
          <FeatBullet
            n="05"
            t="Live spectator view"
            d="Share a link. Parents, friends, your grandma — they all get the live bracket."
          />
          <FeatBullet
            n="06"
            t="Export your data"
            d="One JSON download. Full match history. It's yours. Delete your account and take it with you."
          />
        </div>
      </div>
    </section>
  )
}

function FeatBullet({ n, t, d }: { n: string; t: string; d: string }) {
  return (
    <div className="feat-bullet">
      <div className="fb-n mono">{n}</div>
      <h3 className="fb-t">{t}</h3>
      <p className="fb-d">{d}</p>
    </div>
  )
}

function FeatTrack() {
  return (
    <div className="feat-panel">
      <div className="feat-panel-copy">
        <h3 className="fp-h">Scores in, history out.</h3>
        <p className="fp-p">
          Tap the score after every rally. Games end themselves. The app watches
          for deuce, win-by-2, change-of-ends. Save the match and it's on your
          profile, in your club feed, and in your head-to-head record. No forms.
          No dropdowns.
        </p>
        <ul className="fp-list">
          <li>Score with one finger on the bench</li>
          <li>Auto-detect deuce &amp; game point</li>
          <li>Head-to-head and rating delta on save</li>
        </ul>
      </div>
      <MatchLogMock />
    </div>
  )
}

function FeatRate() {
  return (
    <div className="feat-panel">
      <div className="feat-panel-copy">
        <h3 className="fp-h">A rating you can trust.</h3>
        <p className="fp-p">
          Glicko-2 under the hood. Every match moves your number. Every number
          has a confidence range. Nothing is gamed, nothing is pay-to-win —
          because there's nothing to pay for.
        </p>
        <ul className="fp-list">
          <li>Provisional → stable as you play</li>
          <li>Separate singles and doubles ratings</li>
          <li>Club-level and global leaderboards</li>
        </ul>
      </div>
      <RatingMock />
    </div>
  )
}

function FeatRun() {
  return (
    <div className="feat-panel">
      <div className="feat-panel-copy">
        <h3 className="fp-h">The schedule, solved.</h3>
        <p className="fp-p">
          Our scheduler treats your constraints as rules: how many courts, how
          long the lunch break, who can't play back-to-back. It returns a
          schedule that respects every one.
        </p>
        <ul className="fp-list">
          <li>Round-robin and single-elimination draws</li>
          <li>Live scoring from the scorers' table</li>
          <li>Public bracket link for spectators</li>
        </ul>
      </div>
      <BracketMock />
    </div>
  )
}

function FeatWatch() {
  return (
    <div className="feat-panel">
      <div className="feat-panel-copy">
        <h3 className="fp-h">Broadcast, without a broadcaster.</h3>
        <p className="fp-p">
          Every tournament has a public spectator URL. Big type. Live scores.
          Upcoming matches on the right. Share it with anyone — works without an
          account, without an app.
        </p>
        <ul className="fp-list">
          <li>Full-screen court view</li>
          <li>Per-player follow links</li>
          <li>Embed on your club's website</li>
        </ul>
      </div>
      <SpectatorMock />
    </div>
  )
}

/* ---- Mocks ---- */
function MatchLogMock() {
  return (
    <div className="mock mock-phone">
      <div className="mp-bar">
        <span className="mp-time mono">9:41</span>
        <span className="mp-dots">
          <span />
          <span />
          <span />
        </span>
      </div>
      <div className="mp-head">
        <div className="mp-head-l">
          <div className="mp-eyebrow">
            <span className="ball-dot ball-dot--live" />
            LIVE · GAME 3
          </div>
          <div className="mp-title">Match · Club Tuesday</div>
        </div>
        <div className="mp-clock mono">14:02</div>
      </div>
      <div className="mp-players">
        <div className="mp-player mp-player--win">
          <div className="mp-avatar">TN</div>
          <div className="mp-name">You</div>
          <div className="mp-score mono">08</div>
        </div>
        <div className="mp-player">
          <div className="mp-avatar">DO</div>
          <div className="mp-name">D. Okafor</div>
          <div className="mp-score mono">06</div>
        </div>
      </div>
      <div className="mp-games">
        <div className="mp-g">
          <span>11</span>
          <i />
          <span className="muted">9</span>
        </div>
        <div className="mp-g">
          <span className="muted">7</span>
          <i />
          <span>11</span>
        </div>
        <div className="mp-g is-live">
          <span>8</span>
          <i />
          <span className="muted">6</span>
        </div>
      </div>
      <div className="mp-keypad">
        <button className="mp-key mp-key--me">+1 you</button>
        <button className="mp-key mp-key--them">+1 D.O.</button>
      </div>
      <div className="mp-hint">Swipe ↓ to end game · Hold to undo</div>
    </div>
  )
}

function RatingMock() {
  return (
    <div className="mock mock-rating">
      <div className="rt-head">
        <div>
          <div className="rt-label">Your rating</div>
          <div className="rt-big mono">2157</div>
          <div className="rt-sub">
            <span className="rt-delta">+12</span> last match · RD 42
          </div>
        </div>
        <div className="rt-chip">Top 8% · New Delhi</div>
      </div>
      <svg viewBox="0 0 300 80" className="rt-chart" preserveAspectRatio="none">
        <defs>
          <linearGradient id="rt-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#FF7A1A" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#FF7A1A" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M0,60 L20,55 L40,58 L60,48 L80,52 L100,40 L120,44 L140,36 L160,42 L180,28 L200,32 L220,22 L240,18 L260,24 L280,14 L300,10 L300,80 L0,80 Z"
          fill="url(#rt-fill)"
        />
        <path
          d="M0,60 L20,55 L40,58 L60,48 L80,52 L100,40 L120,44 L140,36 L160,42 L180,28 L200,32 L220,22 L240,18 L260,24 L280,14 L300,10"
          fill="none"
          stroke="#FF7A1A"
          strokeWidth="1.8"
        />
        <circle cx="300" cy="10" r="4" fill="#FF7A1A" />
      </svg>
      <div className="rt-meta">
        <div>
          <div className="rt-m-l">Won</div>
          <div className="rt-m-v mono">128</div>
        </div>
        <div>
          <div className="rt-m-l">Lost</div>
          <div className="rt-m-v mono">94</div>
        </div>
        <div>
          <div className="rt-m-l">Win%</div>
          <div className="rt-m-v mono">57.7</div>
        </div>
        <div>
          <div className="rt-m-l">Streak</div>
          <div className="rt-m-v mono">W5</div>
        </div>
      </div>
    </div>
  )
}

type BracketEntry = { seed: number | string; name: string; s: number | string; win?: number }
type BracketMatch = { winner?: boolean; live?: boolean; a: BracketEntry; b: BracketEntry }

function BracketMock() {
  const r1: BracketMatch[] = [
    { winner: true, a: { seed: 1, name: 'Nguyen', s: 3, win: 1 }, b: { seed: 8, name: 'Okafor', s: 1 } },
    { winner: true, a: { seed: 4, name: 'Park', s: 3, win: 1 }, b: { seed: 5, name: 'Alvarez', s: 2 } },
    { live: true, a: { seed: 3, name: 'Hassan', s: 2 }, b: { seed: 6, name: 'Rao', s: 2 } },
    { a: { seed: 2, name: 'Liang', s: '—' }, b: { seed: 7, name: 'Bauer', s: '—' } },
  ]
  const r2: BracketMatch[] = [
    { a: { seed: 1, name: 'Nguyen', s: '—' }, b: { seed: 4, name: 'Park', s: '—' } },
    { a: { seed: '?', name: 'Winner R3', s: '—' }, b: { seed: '?', name: 'Winner R4', s: '—' } },
  ]
  const r3: BracketMatch[] = [
    { a: { seed: '?', name: 'Final A', s: '—' }, b: { seed: '?', name: 'Final B', s: '—' } },
  ]

  const round = (pairs: BracketMatch[], i: number) => (
    <div className="br-round" key={i}>
      {pairs.map((p, j) => (
        <div
          className={`br-match ${p.winner ? 'is-done' : ''} ${p.live ? 'is-live' : ''}`}
          key={j}
        >
          <div className={`br-row ${p.a.win ? 'is-win' : ''}`}>
            <span className="br-seed mono">{p.a.seed}</span>
            <span className="br-name">{p.a.name}</span>
            <span className="br-s mono">{p.a.s}</span>
          </div>
          <div className={`br-row ${p.b.win ? 'is-win' : ''}`}>
            <span className="br-seed mono">{p.b.seed}</span>
            <span className="br-name">{p.b.name}</span>
            <span className="br-s mono">{p.b.s}</span>
          </div>
        </div>
      ))}
    </div>
  )

  return (
    <div className="mock mock-bracket">
      <div className="br-chrome">
        <span className="mono br-chrome-l">DRAW · MEN'S SINGLES · R16 → FINAL</span>
        <span className="br-chrome-r">
          <span className="ball-dot ball-dot--live" /> 1 of 8 courts live
        </span>
      </div>
      <div className="br-body">
        {round(r1, 0)}
        {round(r2, 1)}
        {round(r3, 2)}
      </div>
    </div>
  )
}

function SpectatorMock() {
  return (
    <div className="mock mock-spec">
      <div className="sp-top">
        <span className="mono sp-l">
          <span className="ball-dot ball-dot--live" /> COURT 3 · LIVE · GAME 4
        </span>
        <span className="mono sp-r">DELHI OPEN 2026 · DAY 2</span>
      </div>
      <div className="sp-row">
        <div className="sp-side sp-side--a">
          <div className="sp-flag">🇻🇳</div>
          <div className="sp-name">NGUYEN</div>
          <div className="sp-seed mono">SEED 1</div>
        </div>
        <div className="sp-score">
          <div className="sp-big mono">11</div>
          <div className="sp-sets mono">SETS 2 – 1</div>
          <div className="sp-big sp-big--b mono">08</div>
        </div>
        <div className="sp-side sp-side--b">
          <div className="sp-flag">🇳🇬</div>
          <div className="sp-name">OKAFOR</div>
          <div className="sp-seed mono">SEED 8</div>
        </div>
      </div>
      <div className="sp-foot">
        <span>fortymm.com/delhi-open/court-3</span>
        <span>Embed · Share · Follow</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Tournaments band                                                  */
/* ------------------------------------------------------------------ */
function TournamentsBand() {
  return (
    <section id="tournaments" className="tb">
      <div className="section-inner tb-inner">
        <div className="tb-copy">
          <div className="eyebrow">
            <span className="ball-dot" />
            For tournament directors
          </div>
          <h2 className="section-h2 display">
            The math is quiet.
            <br />
            <span className="accent">The rallies are loud.</span>
          </h2>
          <p className="tb-p">
            Running a tournament is a scheduling nightmare. Byes, constraints,
            courts, breaks, one player who drove four hours and can't go
            back-to-back. FortyMM's scheduler treats your constraints as rules
            and gives you a schedule that respects every one.
          </p>
          <ul className="tb-list">
            <li><span className="mono tb-k">01</span> Import a player list — CSV, paste, or scan.</li>
            <li><span className="mono tb-k">02</span> Set constraints — courts, breaks, start times.</li>
            <li><span className="mono tb-k">03</span> Generate — and share the bracket link.</li>
            <li><span className="mono tb-k">04</span> Score live from the scorers' table.</li>
          </ul>
          <div className="tb-ctas">
            <Link className="btn btn-primary" to="/tournaments">
              <span className="btn-dot" />
              Start a tournament
            </Link>
            <a className="btn btn-ghost" href="#tournaments">
              See a sample schedule →
            </a>
          </div>
        </div>

        <SolverCard />
      </div>
    </section>
  )
}

type SolverLine = { t: 'constraint' | 'solve'; txt: string }

function SolverCard() {
  const lines: SolverLine[] = [
    { t: 'constraint', txt: '32 players · 4 courts · 3 hr block' },
    { t: 'constraint', txt: 'no back-to-back within 20 min' },
    { t: 'constraint', txt: 'seeds 1–4 on court 1 in R16' },
    { t: 'constraint', txt: 'lunch break 12:30–13:15' },
    { t: 'solve', txt: 'schedule found in 287 ms' },
  ]
  const [line, setLine] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setLine((l) => (l + 1) % (lines.length + 2)), 1200)
    return () => clearInterval(id)
  }, [lines.length])

  return (
    <div className="solver">
      <div className="sv-head">
        <span className="mono sv-head-l">scheduler.fortymm</span>
        <span className="sv-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="sv-body mono">
        {lines.slice(0, Math.min(line + 1, lines.length)).map((l, i) => (
          <div key={i} className={`sv-line sv-line--${l.t}`}>
            <span className="sv-arrow">{l.t === 'solve' ? '✓' : '›'}</span>
            <span className="sv-label">{l.t}</span>
            <span className="sv-txt">{l.txt}</span>
          </div>
        ))}
        {line >= lines.length && (
          <>
            <div className="sv-line sv-line--out">
              <span className="sv-arrow">→</span>
              <span className="sv-label">schedule</span>
              <span className="sv-txt">courts × rounds × players</span>
            </div>
            <div className="sv-grid">
              {Array.from({ length: 4 }).map((_, r) => (
                <div key={r} className="sv-grid-row">
                  <span className="mono sv-grid-l">CT{r + 1}</span>
                  {Array.from({ length: 8 }).map((_, c) => (
                    <span
                      key={c}
                      className="sv-cell"
                      style={{
                        background:
                          (r + c) % 3 === 0
                            ? 'var(--ball-500)'
                            : (r + c) % 5 === 0
                              ? 'var(--serve-500)'
                              : 'var(--ink-700)',
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Manifesto                                                         */
/* ------------------------------------------------------------------ */
function Manifesto() {
  const promises = [
    {
      n: '01',
      t: 'No ads. Not now, not ever.',
      d: "Every other sports-tracker ends up plastered in sportsbook banners. Ours won't. That's a commitment, not a roadmap item.",
    },
    {
      n: '02',
      t: 'No premium tier.',
      d: 'Every feature works for everyone. No unlocks. No trials. No “upgrade to see the full bracket” garbage.',
    },
    {
      n: '03',
      t: "We don't sell your data.",
      d: 'No trackers. No third-party analytics. No cookie-consent theater. We keep what the app needs. Nothing else.',
    },
    {
      n: '04',
      t: 'Accounts are optional.',
      d: 'You get one the moment you open the site. Your matches are tracked immediately. Add an email when — or if — you want to keep them forever.',
    },
    {
      n: '05',
      t: 'Your data is yours.',
      d: "One-click export. One-click anonymize. We can't fully delete — your matches live in other players' histories too — but your name, photo, and email vanish from every record, instantly.",
    },
    {
      n: '06',
      t: 'Open-source, GPLv3.',
      d: 'Read the code. Self-host if you want. If we ever do something shady, fork us.',
    },
  ]

  return (
    <section id="manifesto" className="manifesto">
      <div className="section-inner">
        <div className="mf-head">
          <div className="eyebrow">
            <span className="ball-dot" />
            Manifesto
          </div>
          <h2 className="section-h2 display">
            Six promises.
            <br />
            <span className="accent">Zero asterisks.</span>
          </h2>
          <p className="mf-lede">
            Most sports-tracker apps start free, then put the good stuff behind
            a paywall, then start selling your data, then go out of business.
            We're doing none of those things. Here's the commitment in writing.
          </p>
        </div>

        <div className="mf-grid">
          {promises.map((p) => (
            <div key={p.n} className="mf-card">
              <div className="mf-n mono">{p.n}</div>
              <h3 className="mf-t">{p.t}</h3>
              <p className="mf-d">{p.d}</p>
            </div>
          ))}
        </div>

        <Founder />
      </div>
    </section>
  )
}

function Founder() {
  return (
    <div className="founder">
      <div className="fd-photo">
        <svg
          viewBox="0 0 160 200"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <linearGradient id="fd-bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#B94700" />
              <stop offset="100%" stopColor="#0B0D12" />
            </linearGradient>
          </defs>
          <rect width="160" height="200" fill="url(#fd-bg)" />
          <circle cx="80" cy="70" r="28" fill="#FFB57A" opacity="0.85" />
          <path
            d="M30 200 Q30 130 80 130 Q130 130 130 200 Z"
            fill="#FFB57A"
            opacity="0.85"
          />
          <g transform="translate(110,95) rotate(25)">
            <ellipse cx="0" cy="0" rx="14" ry="18" fill="#0B0D12" />
            <rect x="-3" y="16" width="6" height="22" fill="#0B0D12" rx="1" />
            <ellipse cx="0" cy="0" rx="11" ry="15" fill="#FF7A1A" />
          </g>
          <circle cx="48" cy="88" r="5" fill="#FF7A1A" />
        </svg>
        <div className="fd-photo-tag mono">
          PLACEHOLDER · YOU CAN ADD A REAL PHOTO
        </div>
      </div>
      <div className="fd-copy">
        <div className="eyebrow">
          <span className="ball-dot" />
          Made by players
        </div>
        <blockquote className="fd-quote">
          “I run a small club in the back of a community center. Every Tuesday
          it's 24 people and one chalkboard. I got tired of the apps that wanted
          my email, my credit card, and my grandmother's maiden name just to log
          a best-of-five. So I built this with a few friends. It's free because
          that's the whole point.”
        </blockquote>
        <div className="fd-cred">
          <div className="fd-name">T. Nguyen</div>
          <div className="fd-role">
            Founder · Rated 2145 · Will beat you at short pips
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  FAQ                                                               */
/* ------------------------------------------------------------------ */
function FAQ() {
  const qs = [
    {
      q: 'Is it really free?',
      a: 'Yes. Free forever, no credit card, no "try it free" gotcha. We\'re not a startup burning VC to get you hooked. We\'re players. Running the servers costs us about the price of a nice paddle per month. We\'re fine.',
    },
    {
      q: 'Do I need an account?',
      a: 'No. The first time you open the site we quietly give you an ephemeral account — your matches and ratings start tracking immediately. If you want them forever, add an email at any time and it upgrades to a real account. No sign-up wall. Ever.',
    },
    {
      q: "What's on the web vs. in the apps?",
      a: 'Right now: the web is the whole product. Match tracking, ratings, club feeds, the full tournament admin, the spectator view — it all works in your browser on any phone or laptop. Native iOS and Android apps are next; they\'ll be the same product with nicer score entry and push notifications.',
    },
    {
      q: 'How does the rating work?',
      a: 'Glicko-2 — a modern rating system that tracks both your skill and the uncertainty around it. Play more, uncertainty drops. Beat a higher-rated player, you gain more. No secret sauce. We show the formula in the docs.',
    },
    {
      q: 'Can I run a tournament with this?',
      a: "Yes — that's half the product. Round-robin and single-elimination draws. Our scheduler treats your constraints (courts, breaks, back-to-backs) as rules and finds a schedule that respects all of them. Free for any club, any size, any country.",
    },
    {
      q: 'How do you make money?',
      a: "We don't. The project is funded out-of-pocket by the people who maintain it and accepts small donations from clubs that want to. We have no investors, no runway, no growth team. If that ever changes, you'll be the first to know.",
    },
    {
      q: 'What happens to my data if you shut down?',
      a: 'You can export everything as JSON at any time. The client-side code and server code are GPLv3 — if we ever disappear, someone else can spin it up, or you can self-host. The data is portable and the code is yours.',
    },
    {
      q: 'Can I self-host it?',
      a: 'Yes. The whole stack is open source. Docker compose, one command, on a $5 VPS. The scheduler is the heaviest part and it still runs fine on a cheap box.',
    },
  ]
  const [open, setOpen] = useState<number>(0)

  return (
    <section id="faq" className="faq">
      <div className="section-inner">
        <div className="section-head">
          <div className="eyebrow">
            <span className="ball-dot" />
            FAQ
          </div>
          <h2 className="section-h2 display">
            Short answers
            <br />
            <span className="muted">to the questions everyone asks.</span>
          </h2>
        </div>

        <div className="faq-list">
          {qs.map((item, i) => (
            <div key={i} className={`faq-item ${open === i ? 'is-open' : ''}`}>
              <button
                className="faq-q"
                onClick={() => setOpen(open === i ? -1 : i)}
              >
                <span className="faq-n mono">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="faq-qt">{item.q}</span>
                <span className="faq-chev">{open === i ? '–' : '+'}</span>
              </button>
              {open === i && <div className="faq-a">{item.a}</div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  CTA                                                               */
/* ------------------------------------------------------------------ */
function CtaBand() {
  return (
    <section id="play" className="cta">
      <div className="fortymm-grid-bg cta-grid" />
      <div className="cta-inner">
        <div className="eyebrow">
          <span className="ball-dot" />
          One click. No form.
        </div>
        <h2 className="cta-h2 display">
          Open FortyMM.
          <br />
          <span className="accent">Play your first match.</span>
        </h2>
        <p className="cta-p">
          We give you an account the moment the page loads. Your first match is
          already being tracked. If you ever want to keep it, add an email.
        </p>
        <div className="cta-ctas">
          <Link className="btn btn-primary btn-xl" to="/matches/new">
            <span className="btn-dot" />
            Start playing now
          </Link>
          {/*
            The TestFlight beta is public — anyone with the link can join — so
            a logged-out visitor gets the same working link the signed-in
            sidebar shows (`app-shell.tsx`). Android has no build at all, which
            is why the button beside this one stays inert.
          */}
          <a
            className="btn btn-secondary btn-xl"
            href={TESTFLIGHT_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="Join the public TestFlight beta"
          >
            Get the iOS app
          </a>
          <span
            className="btn btn-secondary btn-xl btn-disabled"
            aria-disabled="true"
            title="Coming soon — Android is in beta"
          >
            Get the Android app
          </span>
        </div>
        <div className="cta-foot mono">
          ● Web is live · iOS in beta · Android in beta
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Footer                                                            */
/* ------------------------------------------------------------------ */
function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="ft-brand">
          <Wordmark size={22} />
          <p className="ft-tag">
            Made by players, in basements and rec centers.
            <br />© 2026 FortyMM. GPLv3. For the love of the game.
          </p>
        </div>
        <FooterCol
          h="Product"
          items={[
            { label: 'Web app', to: '/matches/new' },
            { label: 'iOS (beta)', disabled: true },
            { label: 'Android (beta)', disabled: true },
            { label: 'Spectator view', disabled: true },
            { label: 'Changelog', disabled: true },
          ]}
        />
        <FooterCol
          h="For directors"
          items={[
            { label: 'Run a tournament', to: '/tournaments' },
            { label: 'Scheduler', href: '#tournaments' },
            { label: 'Sample draws', disabled: true },
            { label: "Scorers' guide", disabled: true },
          ]}
        />
        <FooterCol
          h="Community"
          items={[
            { label: 'Discord', disabled: true },
            { label: 'GitHub', href: GITHUB_URL, external: true },
            { label: 'Clubs map', disabled: true },
            { label: 'Contribute', href: GITHUB_URL, external: true },
          ]}
        />
        <FooterCol
          h="Never"
          items={[
            { label: 'Ads', disabled: true },
            { label: 'Trackers', disabled: true },
            { label: 'Premium', disabled: true },
            { label: 'Cookie banners', disabled: true },
          ]}
        />
      </div>
      <div className="footer-bar">
        <span className="mono">v0.9.0 · commit a4f2e1 · status: operational</span>
        <span className="mono">Play more. Pay never.</span>
      </div>
    </footer>
  )
}

type FooterItem = {
  label: string
  /** In-app route (renders a TanStack <Link>). */
  to?: string
  /** Raw href: an external URL (with `external`) or an in-page `#anchor`. */
  href?: string
  /** Open in a new tab (set for off-site links). */
  external?: boolean
  /** No destination yet — render as inert, visibly-dimmed text, not a link. */
  disabled?: boolean
}

function FooterCol({ h, items }: { h: string; items: FooterItem[] }) {
  return (
    <div className="ft-col">
      <div className="ft-col-h">{h}</div>
      {items.map((item) => (
        <FooterLink key={item.label} item={item} />
      ))}
    </div>
  )
}

function FooterLink({ item }: { item: FooterItem }) {
  const { label, to, href, external, disabled } = item

  if (disabled || (!to && !href)) {
    return (
      <span className="ft-col-i ft-col-i-disabled" aria-disabled="true">
        {label}
      </span>
    )
  }

  if (to) {
    return (
      <Link to={to} className="ft-col-i">
        {label}
      </Link>
    )
  }

  return (
    <a
      href={href}
      className="ft-col-i"
      {...(external
        ? { target: '_blank', rel: 'noreferrer noopener' }
        : {})}
    >
      {label}
    </a>
  )
}
