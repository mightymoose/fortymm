// FortyMM tournament admin — Tables & schedule.
// Tokens come from colors_and_type.css. Orange = actions/selection only.

const AD_NOW = 11 * 60 + 15; // 11:15
const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const adBtn = { height: 36, padding: '0 14px', borderRadius: 8, font: '600 14px var(--font-ui)', cursor: 'pointer', border: '1px solid transparent', whiteSpace: 'nowrap' };
const adPrimary = { ...adBtn, background: 'var(--accent)', color: 'var(--on-accent)' };
const adSecondary = { ...adBtn, background: 'transparent', color: 'var(--fg-1)', borderColor: 'var(--border-control)' };

function AdSidebar() {
  const items = ['Overview', 'Tables & schedule', 'Draws', 'Players', 'Results', 'Settings'];
  return (
    <aside style={{ width: 216, flex: 'none', background: 'var(--bg-panel)', borderRight: '1px solid var(--border-subtle)', padding: '20px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <img src="../../assets/logo-wordmark.svg" alt="FortyMM" style={{ height: 30, alignSelf: 'flex-start', margin: '0 8px 20px' }} />
      <div style={{ padding: '0 8px 12px' }}>
        <div style={{ font: '600 15px var(--font-ui)', color: 'var(--fg-1)' }}>Spring Open</div>
        <div style={{ font: '400 13px var(--font-ui)', color: 'var(--fg-3)' }}>Saturday · Riverside TT</div>
      </div>
      {items.map((l, i) => {
        const on = i === 1;
        return <a key={l} style={{ padding: '9px 10px', borderRadius: 8, font: '500 14px var(--font-ui)', textDecoration: 'none', cursor: 'pointer', background: on ? 'var(--accent-soft)' : 'transparent', color: on ? 'var(--accent-text)' : 'var(--fg-2)' }}>{l}</a>;
      })}
    </aside>
  );
}

function AdFacts({ finish, planned }) {
  const late = finish - planned;
  const facts = [
    ['Expected finish', fmt(finish), late > 0 ? `${late} min after plan (${fmt(planned)})` : 'On plan', late > 0],
    ['Tables in use', '4 of 6', '2 free now'],
    ['Matches left', '38', 'of 112'],
    ['Players resting', '7', 'shortest rest 5 min'],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', borderTop: '1px solid var(--border-subtle)', borderBottom: '1px solid var(--border-subtle)' }}>
      {facts.map(([l, v, s, warn], i) => (
        <div key={l} style={{ padding: '14px 20px', borderLeft: i ? '1px solid var(--border-subtle)' : 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ font: '500 13px var(--font-ui)', color: 'var(--fg-3)' }}>{l}</span>
          <span style={{ font: `700 ${i === 0 ? 30 : 24}px/1.15 var(--font-num)`, color: 'var(--fg-1)' }}>{v}</span>
          <span style={{ font: '400 13px var(--font-ui)', color: warn ? 'var(--conflict)' : 'var(--fg-3)' }}>{s}</span>
        </div>
      ))}
    </div>
  );
}

function AdAttention({ issues, onResolve, resolvedNote }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 0, border: `1px solid ${issues.length ? 'var(--conflict)' : 'var(--border-subtle)'}`, borderRadius: 8, background: issues.length ? 'var(--conflict-soft)' : 'transparent' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
        <span style={{ display: 'inline-grid', placeItems: 'center', width: 20, height: 20, borderRadius: '50%', background: issues.length ? 'var(--conflict)' : 'var(--green-400)', color: 'var(--ink-950)', font: '700 12px var(--font-ui)' }}>{issues.length ? '!' : '✓'}</span>
        <h2 style={{ margin: 0, font: '600 16px var(--font-ui)', color: 'var(--fg-1)' }}>{issues.length ? `${issues.length} scheduling ${issues.length === 1 ? 'issue needs' : 'issues need'} a decision` : 'No scheduling issues'}</h2>
        {resolvedNote && <span style={{ font: '400 14px var(--font-ui)', color: 'var(--fg-2)' }}>{resolvedNote}</span>}
      </div>
      {issues.map(it => (
        <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px', borderTop: '1px solid rgba(245,197,66,0.25)', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 360px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ font: '600 15px var(--font-ui)', color: 'var(--fg-1)' }}>{it.title}</span>
            <span style={{ font: '400 14px/1.45 var(--font-ui)', color: 'var(--fg-2)' }}>{it.detail}</span>
          </div>
          <button style={adSecondary}>Show in schedule</button>
          <button style={adPrimary} onClick={() => onResolve(it)}>{it.action}</button>
        </div>
      ))}
    </section>
  );
}

const TABLES = [
  { n: 1, live: true, a: 'Johansen-Whitfield, Annika', b: 'Rossi, Giulia', g: [1, 0], p: [4, 7], srv: 1, game: 2, mins: 14, next: 'Kim vs Dubois' },
  { n: 2, live: true, a: 'Okafor, Daniel', b: 'Johansen, Anders', g: [1, 1], p: [9, 9], srv: 0, game: 3, mins: 31, next: 'Patel vs Park', late: 15 },
  { n: 3, live: true, a: 'Nguyen, Thanh', b: 'Silva, Rafael', g: [1, 1], p: [8, 6], srv: 0, game: 3, mins: 22, next: 'Chen vs Ali' },
  { n: 4, live: true, a: 'Tanaka, Yuki', b: 'Müller, Friedrich', g: [0, 0], p: [3, 2], srv: 1, game: 1, mins: 4, next: 'Ahmed vs Hansen' },
  { n: 5, free: 'since 11:08', ready: ['Kim, Hyun-woo', 'Ali, Rashid'] },
  { n: 6, free: 'since 11:12', ready: ['Rossi, Marco', 'Dubois, Claire'], note: 'Dubois finished 11:02 — rest ends 11:17' },
];

function AdTable({ t }) {
  const head = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ font: '600 17px var(--font-ui)', color: 'var(--fg-1)' }}>Table {t.n}</span>
      {t.live ? <span className="live-marker">Live</span> : <span style={{ font: '600 13px var(--font-ui)', color: 'var(--fg-2)' }}>Free {t.free}</span>}
    </div>
  );
  if (!t.live) return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {head}
      <div style={{ font: '400 14px var(--font-ui)', color: 'var(--fg-3)' }}>Ready to call</div>
      <div style={{ font: '600 16px/1.35 var(--font-ui)', color: 'var(--fg-1)' }}>{t.ready[0]}<br />{t.ready[1]}</div>
      <div style={{ font: '400 13px var(--font-ui)', color: t.note ? 'var(--rest)' : 'var(--fg-3)' }}>{t.note || 'Both checked in'}</div>
      <button style={{ ...(t.note ? adSecondary : adPrimary), marginTop: 'auto', alignSelf: 'flex-start' }}>{t.note ? 'Call at 11:17' : 'Call to table'}</button>
    </div>
  );
  const row = (name, g, p, srv) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 12px 20px 36px', gap: 8, alignItems: 'center' }}>
      <span style={{ font: '500 15px/1.3 var(--font-ui)', color: 'var(--fg-1)' }}>{name}</span>
      <span>{srv && <span className="serve-marker" style={{ width: 8, height: 8 }}></span>}</span>
      <span style={{ font: '500 14px var(--font-num)', color: 'var(--fg-3)', textAlign: 'right' }}>{g}</span>
      <span style={{ font: '700 24px/1 var(--font-num)', color: 'var(--fg-1)', textAlign: 'right' }}>{p}</span>
    </div>
  );
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {head}
      {row(t.a, t.g[0], t.p[0], t.srv === 0)}
      {row(t.b, t.g[1], t.p[1], t.srv === 1)}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, font: '400 13px var(--font-ui)', color: 'var(--fg-3)', borderTop: '1px solid var(--border-subtle)', paddingTop: 8, flexWrap: 'wrap' }}>
        <span>Game {t.game} · {t.mins} min{t.late ? <span style={{ color: 'var(--conflict)' }}> · {t.late} min over</span> : null}</span>
        <span>Next: {t.next}</span>
      </div>
    </div>
  );
}

// schedule: [start, dur, a, b, status]
const SCHED = [
  [[620, 35, 'Nguyen', 'Silva', 'done'], [665, 35, 'Johansen-Whitfield', 'Rossi', 'live'], [710, 35, 'Kim', 'Dubois'], [755, 35, 'Tanaka', 'Chen']],
  [[620, 35, 'Okafor', 'Park', 'done'], [664, 50, 'Okafor', 'Johansen', 'live'], [715, 35, 'Patel', 'Park', 'conflict'], [760, 35, 'Hansen', 'Müller']],
  [[620, 35, 'Chen', 'Ali', 'done'], [673, 35, 'Nguyen', 'Silva', 'live'], [715, 35, 'Chen', 'Ali'], [760, 35, 'Okafor', 'Kim']],
  [[625, 35, 'Ahmed', 'Hansen', 'done'], [671, 35, 'Tanaka', 'Müller', 'live'], [715, 35, 'Ahmed', 'Hansen'], [760, 35, 'Patel', 'Nguyen']],
  [[620, 35, 'Patel', 'Rossi', 'done'], [680, 35, 'Kim', 'Ali'], [725, 35, 'Silva', 'Johansen'], [770, 35, 'Okafor', 'Ali', 'conflict']],
  [[627, 35, 'Dubois', 'Tran', 'done'], [677, 35, 'Rossi', 'Dubois'], [725, 35, 'Park', 'Tanaka'], [770, 35, 'Chen', 'Rossi']],
];

function AdSchedule({ fixed }) {
  const start = 600, endT = 840, ppm = 4.4, labelW = 76;
  const hours = [];
  for (let m = start; m <= endT; m += 60) hours.push(m);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, font: '600 18px var(--font-ui)', color: 'var(--fg-1)' }}>Schedule</h2>
        <span style={{ font: '400 14px var(--font-ui)', color: 'var(--fg-3)' }}>10:00–14:00 · hover a match for full names</span>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
        <div style={{ position: 'relative', width: labelW + (endT - start) * ppm + 16, paddingBottom: 8 }}>
          <div style={{ height: 32, position: 'relative', borderBottom: '1px solid var(--border-subtle)' }}>
            {hours.map(h => <span key={h} style={{ position: 'absolute', left: labelW + (h - start) * ppm, top: 8, font: '500 13px var(--font-num)', color: 'var(--fg-3)', paddingLeft: 6, borderLeft: '1px solid var(--border-subtle)', height: 24 }}>{fmt(h)}</span>)}
          </div>
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: labelW + (AD_NOW - start) * ppm, width: 2, background: 'var(--fg-1)', zIndex: 2 }}>
            <span style={{ position: 'absolute', top: 6, left: 6, font: '600 12px var(--font-num)', color: 'var(--ink-950)', background: 'var(--fg-1)', borderRadius: 4, padding: '1px 5px' }}>Now {fmt(AD_NOW)}</span>
          </div>
          {SCHED.map((row, ti) => (
            <div key={ti} style={{ position: 'relative', height: 76, borderBottom: ti < 5 ? '1px solid var(--border-subtle)' : 'none' }}>
              <span style={{ position: 'absolute', left: 16, top: 28, font: '600 14px var(--font-ui)', color: 'var(--fg-2)' }}>Table {ti + 1}</span>
              {row.map(([s, d, a, b, st], k) => {
                const cf = st === 'conflict' && !fixed.includes(`${ti}-${k}`);
                const done = st === 'done', live = st === 'live';
                return (
                  <div key={k} title={`${a} vs ${b} · ${fmt(s)}–${fmt(s + d)}`} style={{ position: 'absolute', left: labelW + (s - start) * ppm + 2, top: 6, width: d * ppm - 6, height: 64, boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: `1px solid ${cf ? 'var(--conflict)' : 'var(--border-subtle)'}`, background: cf ? 'var(--conflict-soft)' : live ? 'var(--ink-800)' : done ? 'transparent' : 'var(--bg-panel)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    {[a, b].map(n => <span key={n} style={{ font: `${done ? 500 : 600} 13px/1.25 var(--font-ui)`, color: done ? 'var(--fg-3)' : 'var(--fg-1)', overflowWrap: 'anywhere' }}>{n}</span>)}
                    <span style={{ font: '400 12px var(--font-num)', color: cf ? 'var(--conflict)' : live ? 'var(--live)' : 'var(--fg-3)', marginTop: 'auto' }}>{cf ? 'Needs decision' : live ? 'Live' : fmt(s)}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AdSolverDetails() {
  const rules = [
    ['No player plays back-to-back', 'Required', 'Met'],
    ['At least 15 min rest between a player’s matches', 'Required', '1 at risk (Okafor)'],
    ['Matches start when their table is free', 'Required', '1 at risk (Table 2)'],
    ['Doubles and singles for the same player don’t overlap', 'Required', 'Met'],
    ['Spread matches evenly across tables', 'Preferred', 'Met'],
    ['Finish by 18:30', 'Preferred', '10 min over'],
  ];
  return (
    <details style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
      <summary style={{ cursor: 'pointer', font: '600 15px var(--font-ui)', color: 'var(--fg-2)' }}>Scheduling details <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}>· rules, last re-plan 11:09</span></summary>
      <table style={{ marginTop: 12, borderCollapse: 'collapse', width: '100%', maxWidth: 820, font: '400 14px var(--font-ui)', color: 'var(--fg-2)' }}>
        <tbody>{rules.map(r => <tr key={r[0]} style={{ borderBottom: '1px solid var(--border-subtle)' }}><td style={{ padding: '8px 12px 8px 0' }}>{r[0]}</td><td style={{ padding: 8, color: 'var(--fg-3)' }}>{r[1]}</td><td style={{ padding: 8, color: r[2] === 'Met' ? 'var(--fg-3)' : 'var(--conflict)' }}>{r[2]}</td></tr>)}</tbody>
      </table>
      <p style={{ font: '400 13px var(--font-num)', color: 'var(--fg-3)', margin: '12px 0 0' }}>Solver: SMT · 1,248 variables · 12 constraints · solved in 234 ms · objective: minimise finish time</p>
    </details>
  );
}

function AdminApp() {
  const [issues, setIssues] = React.useState([
    { id: 'okafor', key: '4-3', title: 'Okafor’s singles is 15 min over on Table 2', detail: 'He is due on Table 5 at 12:50 for doubles. Moving that match to 13:05 keeps his 15 min rest.', action: 'Move to 13:05', finish: 5 },
    { id: 'patel', key: '1-2', title: 'Table 2 won’t be free for Patel vs Park at 11:55', detail: 'Okafor vs Johansen is still in game 3. Delaying the next match to 12:05 avoids calling players to a busy table.', action: 'Delay to 12:05', finish: 5 },
  ]);
  const [fixed, setFixed] = React.useState([]);
  const [finish, setFinish] = React.useState(18 * 60 + 40);
  const [note, setNote] = React.useState(null);
  const resolve = it => {
    setIssues(xs => xs.filter(x => x.id !== it.id));
    setFixed(f => [...f, it.key]);
    setFinish(f => f + it.finish);
    setNote(`Done — expected finish now ${fmt(finish + it.finish)}.`);
  };
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <AdSidebar />
      <main style={{ flex: 1, minWidth: 0, padding: '20px 24px 40px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <header style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h1 style={{ margin: 0, font: '600 26px/1.2 var(--font-ui)', color: 'var(--fg-1)' }}>Tables &amp; schedule</h1>
            <div style={{ font: '400 14px var(--font-ui)', color: 'var(--fg-3)' }}>Round of 16 in progress · {fmt(AD_NOW)}</div>
          </div>
          <button style={adSecondary}>Pause calling</button>
          <button style={adSecondary}>Add a table</button>
        </header>
        <AdFacts finish={finish} planned={18 * 60 + 30} />
        <AdAttention issues={issues} onResolve={resolve} resolvedNote={note} />
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 12 }}>
          {TABLES.map(t => <AdTable key={t.n} t={t} />)}
        </section>
        <AdSchedule fixed={fixed} />
        <AdSolverDetails />
      </main>
    </div>
  );
}

Object.assign(window, { AdSidebar, AdFacts, AdAttention, AdTable, AdSchedule, AdSolverDetails, AdminApp });
ReactDOM.createRoot(document.getElementById('root')).render(<AdminApp />);
