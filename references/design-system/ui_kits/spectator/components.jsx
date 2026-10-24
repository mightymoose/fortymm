// Spectator bracket — public, shareable, readable from across the hall.
function SpecHeader() {
  return (
    <header style={{ padding: '20px clamp(20px,4vw,40px)', display: 'flex', alignItems: 'center', gap: 20, borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
      <img src="../../assets/logo-wordmark.svg" alt="FortyMM" style={{ height: 30 }} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ font: '600 22px var(--font-ui)', color: 'var(--fg-1)' }}>Spring Open 2026</div>
        <div style={{ font: '400 14px var(--font-ui)', color: 'var(--fg-3)' }}>Saturday · Riverside TT · 64 players</div>
      </div>
      <span className="live-marker" style={{ fontSize: 15 }}>2 matches live</span>
      <button style={{ height: 40, padding: '0 16px', borderRadius: 8, background: 'transparent', border: '1px solid var(--border-control)', color: 'var(--fg-1)', font: '600 14px var(--font-ui)', cursor: 'pointer' }}>Share link</button>
    </header>
  );
}

const SPEC_ROUNDS = [
  { name: 'Round of 16', matches: [
    ['Nguyen, Thanh', 1, 'Silva, Rafael', 16, 3, 1, 'done', 'Table 1'],
    ['Kim, Hyun-woo', 8, 'Dubois, Claire', 9, 3, 0, 'done', 'Table 4'],
    ['Okafor, Daniel', 5, 'Johansen-Whitfield, Annika', 12, 1, 1, 'live', 'Table 2 · game 3 · 9–9'],
    ['Patel, Meera', 4, 'Park, Ji-ho', 13, null, null, 'next', 'Table 2 · about 12:05'],
    ['Tran, Linh', 3, 'Rossi, Giulia', 14, 2, 1, 'live', 'Table 3 · game 4 · 8–6'],
    ['Chen, Wei', 6, 'Ali, Rashid', 11, null, null, 'next', 'Table 5 · 11:20'],
  ] },
  { name: 'Quarterfinals', matches: [
    ['Nguyen, Thanh', 1, 'Kim, Hyun-woo', 8, null, null, 'next', 'Table 1 · 13:10'],
    ['Okafor / Johansen-Whitfield', null, 'Patel / Park', null, null, null, 'tbd', 'About 13:10'],
    ['Tran / Rossi', null, 'Chen / Ali', null, null, null, 'tbd', 'About 13:50'],
  ] },
];

function SpecMatch({ m }) {
  const [a, sa, b, sb, ga, gb, st, where] = m;
  const done = st === 'done';
  const row = (n, seed, g, win) => (
    <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr) 28px', gap: 8, alignItems: 'center' }}>
      <span style={{ font: '500 13px var(--font-num)', color: 'var(--fg-3)' }}>{seed || ''}</span>
      <span style={{ font: `${win ? 700 : 500} 16px/1.3 var(--font-ui)`, color: done && !win ? 'var(--loser)' : st === 'tbd' ? 'var(--fg-3)' : 'var(--fg-1)' }}>{n}</span>
      <span style={{ font: '700 22px var(--font-num)', textAlign: 'right', color: done && !win ? 'var(--loser)' : 'var(--fg-1)' }}>{g ?? ''}</span>
    </div>
  );
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', font: '400 13px var(--font-ui)', color: 'var(--fg-3)' }}>
        {st === 'live' && <span className="live-marker">Live</span>}
        {done && <span style={{ fontWeight: 600, color: 'var(--fg-2)' }}>Final</span>}
        {st === 'next' && <span style={{ fontWeight: 600, color: 'var(--fg-2)' }}>Next</span>}
        <span>{where}</span>
      </div>
      {row(a, sa, ga, done && ga > gb)}
      {row(b, sb, gb, done && gb > ga)}
    </div>
  );
}

function SpecBracket() {
  return (
    <div style={{ padding: '24px clamp(20px,4vw,40px)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 40, alignItems: 'start' }}>
      {SPEC_ROUNDS.map(r => (
        <section key={r.name}>
          <h2 style={{ margin: '0 0 4px', font: '600 18px var(--font-ui)', color: 'var(--fg-1)' }}>{r.name}</h2>
          {r.matches.map((m, i) => <SpecMatch key={i} m={m} />)}
        </section>
      ))}
    </div>
  );
}

Object.assign(window, { SpecHeader, SpecBracket, SpecMatch });
ReactDOM.createRoot(document.getElementById('root')).render(<div><SpecHeader /><SpecBracket /></div>);
