// FortyMM Android — same content model as the iOS kit, with Android chrome
// (top app bar, navigation bar with active indicator, extended FAB). Tokens from colors_and_type.css.

function AndroidFrame({ children }) {
  return (
    <div style={{ width: 384, height: 812, borderRadius: 28, overflow: 'hidden', border: '8px solid #000', outline: '1px solid var(--ink-600)', background: 'var(--bg-app)', position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 28, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', font: '500 13px Roboto, system-ui', color: 'var(--fg-1)' }}>
        <span>19:15</span><span style={{ width: 18, height: 10, border: '1px solid var(--fg-2)', borderRadius: 2 }}></span>
      </div>
      {children}
    </div>
  );
}

function ANavBar({ active = 0 }) {
  const items = ['Today', 'Draws', 'Ratings', 'You'];
  return (
    <nav style={{ height: 80, flex: 'none', display: 'flex', background: 'var(--bg-panel)', borderTop: '1px solid var(--border-subtle)' }}>
      {items.map((l, i) => (
        <a key={l} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, textDecoration: 'none', cursor: 'pointer' }}>
          <span style={{ width: 56, height: 28, borderRadius: 14, background: i === active ? 'var(--accent-soft)' : 'transparent', display: 'grid', placeItems: 'center' }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${i === active ? 'var(--accent-text)' : 'var(--fg-3)'}` }}></span>
          </span>
          <span style={{ font: '500 12px var(--font-ui)', color: i === active ? 'var(--fg-1)' : 'var(--fg-3)' }}>{l}</span>
        </a>
      ))}
    </nav>
  );
}

function ALiveRow({ table, game, a, b, pa, pb, server }) {
  const row = (n, p, srv) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 14px 32px', gap: 8, alignItems: 'center' }}>
      <span style={{ font: '500 16px/1.3 var(--font-ui)', color: 'var(--fg-1)' }}>{n}</span>
      <span>{srv && <span className="serve-marker"></span>}</span>
      <span style={{ font: '700 22px var(--font-num)', textAlign: 'right', color: 'var(--fg-1)' }}>{p}</span>
    </div>
  );
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span className="live-marker">Live</span><span style={{ font: '400 13px var(--font-ui)', color: 'var(--fg-3)' }}>Table {table} · Game {game}</span></div>
      {row(a, pa, server === 0)}{row(b, pb, server === 1)}
    </div>
  );
}

function AHome() {
  const upcoming = [['Tran, Linh', 'Today 20:30', 'Table 4', 2010], ['Silva, Rafael', 'Tomorrow 19:00', 'Riverside TT', 1985]];
  return (
    <>
      <header style={{ height: 64, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 12 }}>
        <span style={{ font: '600 22px var(--font-ui)', color: 'var(--fg-1)', flex: 1 }}>Today</span>
        <span className="fm-avatar" style={{ display: 'inline-grid', placeItems: 'center', width: 32, height: 32, borderRadius: '50%', background: 'var(--ink-700)', font: '600 12px var(--font-ui)', color: 'var(--fg-2)' }}>YO</span>
      </header>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 96px', position: 'relative' }}>
        <h2 style={{ font: '600 16px var(--font-ui)', margin: '4px 0 0', color: 'var(--fg-1)' }}>Live at Riverside TT</h2>
        <ALiveRow table={3} game={3} a="Nguyen, Thanh" b="Okafor, Daniel" pa={8} pb={6} server={0} />
        <h2 style={{ font: '600 16px var(--font-ui)', margin: '24px 0 0', color: 'var(--fg-1)' }}>Your upcoming matches</h2>
        {upcoming.map(([n, t, w, r]) => (
          <div key={n} style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 2 }}>
            <span style={{ font: '600 16px var(--font-ui)', color: 'var(--fg-1)' }}>vs {n}</span>
            <span style={{ font: '400 14px var(--font-num)', color: 'var(--fg-3)', textAlign: 'right' }}>{r.toLocaleString()}</span>
            <span style={{ font: '400 14px var(--font-ui)', color: 'var(--fg-2)' }}>{t} · {w}</span>
          </div>
        ))}
        <h2 style={{ font: '600 16px var(--font-ui)', margin: '24px 0 0', color: 'var(--fg-1)' }}>Recent</h2>
        <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 2 }}>
          <span style={{ font: '600 16px var(--font-ui)', color: 'var(--fg-1)' }}>Lost to Patel, Meera</span>
          <span className="rating-down">▼ −8</span>
          <span style={{ font: '400 13px var(--font-num)', color: 'var(--fg-3)' }}>1–3 · 11–9 8–11 7–11 9–11</span>
        </div>
      </div>
      <button style={{ position: 'absolute', right: 16, bottom: 100, height: 56, padding: '0 20px', borderRadius: 16, border: 0, background: 'var(--accent)', color: 'var(--on-accent)', font: '600 15px var(--font-ui)', cursor: 'pointer' }}>+ Log a match</button>
      <ANavBar active={0} />
    </>
  );
}

Object.assign(window, { AndroidFrame, ANavBar, ALiveRow, AHome });
ReactDOM.createRoot(document.getElementById('root')).render(<div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><AndroidFrame><AHome /></AndroidFrame></div>);
