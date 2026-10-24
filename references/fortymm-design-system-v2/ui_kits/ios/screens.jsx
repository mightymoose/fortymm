// FortyMM mobile — Match scoring screen + Today screen.
// Styles read tokens from colors_and_type.css (linked by index.html).

const mt = {
  num: "var(--font-num)", ui: "var(--font-ui)",
};

function PhoneFrame({ children, label }) {
  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 390, height: 844, borderRadius: 44, overflow: 'hidden', position: 'relative', background: 'var(--bg-app)', border: '8px solid #000', outline: '1px solid var(--ink-600)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 44, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 28px', font: '600 15px -apple-system, system-ui', color: 'var(--fg-1)' }}>
          <span>19:15</span><span style={{ width: 24, height: 11, border: '1px solid var(--fg-2)', borderRadius: 3 }}></span>
        </div>
        {children}
      </div>
      {label && <figcaption style={{ font: '500 13px var(--font-ui)', color: 'var(--fg-3)' }}>{label}</figcaption>}
    </figure>
  );
}

// ---------- scoring logic ----------
const PLAYERS = [
  { last: 'Nguyen', full: 'Nguyen, Thanh', club: 'Riverside TT' },
  { last: 'Okafor', full: 'Okafor, Daniel', club: 'Eastgate' },
];
function serverFor(pts, firstServer) {
  const total = pts[0] + pts[1];
  const swaps = total >= 20 ? 10 + (total - 20) : Math.floor(total / 2);
  return (firstServer + swaps) % 2;
}

function MatchScreen() {
  const [st, setSt] = React.useState({ games: [[11, 6], [9, 11]], pts: [8, 6], hist: [], flash: [0, 0], notice: null });
  const { games, pts, hist, flash, notice } = st;
  const firstServer = games.length % 2; // alternates each game
  const won = [games.filter(g => g[0] > g[1]).length, games.filter(g => g[1] > g[0]).length];
  const matchOver = won[0] === 3 || won[1] === 3;
  const server = serverFor(pts, firstServer);

  function point(i) {
    setSt(s => {
      const w = [s.games.filter(g => g[0] > g[1]).length, s.games.filter(g => g[1] > g[0]).length];
      if (w[0] === 3 || w[1] === 3) return s;
      const np = [...s.pts]; np[i]++;
      const flash = [...s.flash]; flash[i]++;
      const hist = [...s.hist, { games: s.games, pts: s.pts }];
      if (np[i] >= 11 && np[i] - np[1 - i] >= 2) {
        return { games: [...s.games, np], pts: [0, 0], hist, flash, notice: `Game ${s.games.length + 1} to ${PLAYERS[i].last}, ${np[i]}–${np[1 - i]}` };
      }
      return { ...s, pts: np, hist, flash, notice: null };
    });
  }
  function undo() {
    setSt(s => {
      if (!s.hist.length) return s;
      const last = s.hist[s.hist.length - 1];
      return { ...s, games: last.games, pts: last.pts, hist: s.hist.slice(0, -1), notice: 'Point removed' };
    });
  }

  const ghost = { height: 44, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border-control)', background: 'transparent', color: 'var(--fg-1)', font: '600 15px var(--font-ui)', cursor: 'pointer' };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <header style={{ padding: '4px 20px 14px', display: 'flex', flexDirection: 'column', gap: 6, borderBottom: '1px solid var(--border-subtle)' }}>
        <a style={{ font: '500 15px var(--font-ui)', color: 'var(--fg-3)', textDecoration: 'none' }}>‹ Spring Open</a>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ font: '600 22px/1.2 var(--font-ui)', color: 'var(--fg-1)' }}>Table 3</div>
            <div style={{ font: '400 14px var(--font-ui)', color: 'var(--fg-3)' }}>Round of 16 · Best of 5</div>
          </div>
          {matchOver ? <span style={{ font: '600 13px var(--font-ui)', color: 'var(--fg-2)' }}>Final</span> : <span className="live-marker">Live</span>}
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 4 }}>
          <span style={{ font: '500 13px var(--font-ui)', color: 'var(--fg-3)' }}>Games</span>
          {games.map((g, k) => (
            <span key={k} style={{ font: '500 15px var(--font-num)', color: 'var(--fg-2)' }}>
              <b style={{ color: 'var(--fg-1)', fontWeight: g[0] > g[1] ? 700 : 400 }}>{g[0]}</b>–<b style={{ color: 'var(--fg-1)', fontWeight: g[1] > g[0] ? 700 : 400 }}>{g[1]}</b>
            </span>
          ))}
          {!matchOver && <span style={{ font: '500 13px var(--font-ui)', color: 'var(--fg-3)' }}>Game {games.length + 1} now</span>}
        </div>
      </header>

      {[0, 1].map(i => {
        const lead = pts[i] > pts[1 - i];
        return (
          <section key={i} style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gridTemplateRows: '1fr auto', gap: '8px 12px', padding: '16px 20px', borderBottom: i === 0 ? '1px solid var(--border-subtle)' : 'none', minHeight: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'start' }}>
              <div style={{ font: '600 24px/1.2 var(--font-ui)', color: 'var(--fg-1)' }}>{PLAYERS[i].full}</div>
              <div style={{ font: '400 14px var(--font-ui)', color: 'var(--fg-3)' }}>{PLAYERS[i].club} · games won <span style={{ fontFamily: 'var(--font-num)', color: 'var(--fg-1)', fontWeight: 600 }}>{won[i]}</span></div>
              {!matchOver && server === i && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, font: '500 14px var(--font-ui)', color: 'var(--fg-1)' }}>
                  <span className="serve-marker"></span>Serving
                </div>
              )}
            </div>
            <span key={flash[i]} className={flash[i] ? 'score-updated' : ''} aria-live="polite" style={{ alignSelf: 'start', font: '700 112px/1 var(--font-num)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.04em', color: lead || pts[0] === pts[1] ? 'var(--fg-1)' : 'var(--fg-2)', borderRadius: 8, padding: '0 6px', minWidth: 140, textAlign: 'right' }}>{pts[i]}</span>
            <button onClick={() => point(i)} disabled={matchOver} className="fm-press" style={{ gridColumn: '1 / -1', height: 56, borderRadius: 8, border: 0, background: matchOver ? 'var(--bg-panel)' : 'var(--accent)', color: matchOver ? 'var(--fg-disabled)' : 'var(--on-accent)', font: '600 17px var(--font-ui)', cursor: matchOver ? 'default' : 'pointer' }}>
              Point to {PLAYERS[i].last}
            </button>
          </section>
        );
      })}

      <footer style={{ borderTop: '1px solid var(--border-subtle)', padding: '12px 20px 28px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ minHeight: 20, font: '500 14px var(--font-ui)', color: 'var(--fg-2)' }} aria-live="polite">
          {matchOver ? `${PLAYERS[won[0] === 3 ? 0 : 1].last} wins ${Math.max(...won)}–${Math.min(...won)}. Submit to update ratings.` : notice || 'Next on this table: Chen vs Ali, about 20:05'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={undo} disabled={!hist.length} style={{ ...ghost, flex: 1, opacity: hist.length ? 1 : 0.45 }}>Undo point</button>
          <button style={{ ...ghost, flex: 1 }}>{matchOver ? 'Submit result' : 'Time-out'}</button>
        </div>
      </footer>
    </div>
  );
}

// ---------- Today screen ----------
function TodayRow({ head, headColor, a, b, sa, sb, server, live }) {
  const row = (n, s, srv, w) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 14px 32px', gap: 8, alignItems: 'center' }}>
      <span style={{ font: `${w ? 700 : 500} 16px/1.3 var(--font-ui)`, color: w === false ? 'var(--loser)' : 'var(--fg-1)' }}>{n}</span>
      <span>{srv && <span className="serve-marker"></span>}</span>
      <span style={{ font: '700 22px var(--font-num)', textAlign: 'right', color: w === false ? 'var(--loser)' : 'var(--fg-1)' }}>{s}</span>
    </div>
  );
  const done = sa != null && !live;
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {live && <span className="live-marker">Live</span>}
        <span style={{ font: '400 13px var(--font-ui)', color: headColor || 'var(--fg-3)' }}>{head}</span>
      </div>
      {row(a, sa, server === 0, done ? sa > sb : undefined)}
      {row(b, sb, server === 1, done ? sb > sa : undefined)}
    </div>
  );
}

function TodayScreen() {
  const tab = (l, on) => <span style={{ flex: 1, textAlign: 'center', padding: '8px 0', borderRadius: 8, font: '600 13px var(--font-ui)', color: on ? 'var(--accent-text)' : 'var(--fg-3)', background: on ? 'var(--accent-soft)' : 'transparent' }}>{l}</span>;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 20px' }}>
        <div style={{ font: '400 14px var(--font-ui)', color: 'var(--fg-3)' }}>Spring Open · Riverside TT</div>
        <h1 style={{ font: '600 28px/1.2 var(--font-ui)', margin: '2px 0 18px', color: 'var(--fg-1)' }}>Today</h1>

        <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ font: '500 14px var(--font-ui)', color: 'var(--fg-3)' }}>Your next match</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ font: '600 26px/1.1 var(--font-ui)', color: 'var(--fg-1)' }}>Table 2</span>
            <span style={{ font: '600 26px/1.1 var(--font-num)', color: 'var(--fg-1)' }}>19:40</span>
            <span style={{ font: '400 15px var(--font-ui)', color: 'var(--fg-2)' }}>in 25 min</span>
          </div>
          <div style={{ font: '500 17px var(--font-ui)', color: 'var(--fg-1)' }}>vs Park, Ji-ho <span style={{ font: '400 14px var(--font-num)', color: 'var(--fg-3)' }}>1,912</span></div>
          <div style={{ font: '400 14px var(--font-ui)', color: 'var(--rest)' }}>Rest until 19:35 · warm-up table 6 is free</div>
          <button style={{ height: 48, borderRadius: 8, border: 0, background: 'var(--accent)', color: 'var(--on-accent)', font: '600 16px var(--font-ui)', marginTop: 4, cursor: 'pointer' }}>I'm ready</button>
        </section>

        <h2 style={{ font: '600 17px var(--font-ui)', margin: '24px 0 0', color: 'var(--fg-1)' }}>On the tables now</h2>
        <TodayRow live head="Table 3 · Game 3" a="Nguyen, Thanh" b="Okafor, Daniel" sa={8} sb={6} server={0} />
        <TodayRow live head="Table 1 · Game 2" a="Johansen-Whitfield, Annika" b="Rossi, Giulia" sa={4} sb={7} server={1} />

        <h2 style={{ font: '600 17px var(--font-ui)', margin: '24px 0 0', color: 'var(--fg-1)' }}>Your results</h2>
        <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 4 }}>
          <span style={{ font: '600 16px var(--font-ui)', color: 'var(--fg-1)' }}>Won against Silva, Rafael</span>
          <span className="rating-up">▲ +12</span>
          <span style={{ font: '400 13px var(--font-num)', color: 'var(--fg-3)' }}>3–1 · 11–7 9–11 11–8 11–6</span>
          <span style={{ font: '400 13px var(--font-num)', color: 'var(--fg-3)', textAlign: 'right' }}>1,859</span>
        </div>
      </div>
      <nav style={{ display: 'flex', gap: 4, padding: '8px 12px 28px', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-app)' }}>
        {tab('Today', true)}{tab('Draws')}{tab('Ratings')}{tab('You')}
      </nav>
    </div>
  );
}

Object.assign(window, { PhoneFrame, MatchScreen, TodayScreen, TodayRow });

function IOSApp() {
  return (
    <div style={{ display: 'flex', gap: 48, flexWrap: 'wrap', justifyContent: 'center', padding: 40 }}>
      <PhoneFrame label="Scoring a match — tap a point button to try it"><MatchScreen /></PhoneFrame>
      <PhoneFrame label="Player's day at a tournament"><TodayScreen /></PhoneFrame>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<IOSApp />);
