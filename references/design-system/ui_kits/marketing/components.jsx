// FortyMM marketing site. Tokens from colors_and_type.css.

const mkBtn = { height: 48, padding: '0 20px', borderRadius: 8, font: '600 16px var(--font-ui)', cursor: 'pointer', border: '1px solid transparent', display: 'inline-flex', alignItems: 'center' };
const mkPrimary = { ...mkBtn, background: 'var(--accent)', color: 'var(--on-accent)' };
const mkSecondary = { ...mkBtn, background: 'transparent', color: 'var(--fg-1)', borderColor: 'var(--border-control)' };
const mkWrap = { maxWidth: 1180, margin: '0 auto', padding: '0 clamp(20px,5vw,48px)' };

function MkNav() {
  const link = { font: '500 15px var(--font-ui)', color: 'var(--fg-2)', textDecoration: 'none', cursor: 'pointer' };
  return (
    <nav style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ ...mkWrap, display: 'flex', alignItems: 'center', gap: 28, height: 68, flexWrap: 'wrap' }}>
        <img src="../../assets/logo-wordmark.svg" alt="FortyMM" style={{ height: 30 }} />
        <a style={link}>Features</a><a style={link}>For organizers</a><a style={link}>For clubs</a><a style={link}>About</a>
        <div style={{ flex: 1 }}></div>
        <a style={link}>Sign in</a>
        <button style={{ ...mkPrimary, height: 40, fontSize: 15 }}>Get the app</button>
      </div>
    </nav>
  );
}

function MkScorePanel() {
  const row = (n, g, p, srv) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 14px 28px 64px', gap: 10, alignItems: 'center' }}>
      <span style={{ font: '600 20px/1.25 var(--font-ui)', color: 'var(--fg-1)' }}>{n}</span>
      <span>{srv && <span className="serve-marker"></span>}</span>
      <span style={{ font: '500 18px var(--font-num)', color: 'var(--fg-3)', textAlign: 'right' }}>{g}</span>
      <span style={{ font: '700 48px/1 var(--font-num)', color: 'var(--fg-1)', textAlign: 'right' }}>{p}</span>
    </div>
  );
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span style={{ font: '600 17px var(--font-ui)', color: 'var(--fg-1)' }}>Table 3 <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}>· Round of 16 · Game 4</span></span>
        <span className="live-marker">Live</span>
      </div>
      {row('Nguyen, Thanh', 2, 9, true)}
      {row('Okafor, Daniel', 1, 7, false)}
      <div style={{ font: '400 15px var(--font-num)', color: 'var(--fg-3)' }}>11–6 · 9–11 · 11–8</div>
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14, display: 'flex', gap: 24, flexWrap: 'wrap', font: '400 14px var(--font-ui)', color: 'var(--fg-2)' }}>
        <span>4 of 6 tables in use</span>
        <span>Expected finish <b style={{ fontFamily: 'var(--font-num)', color: 'var(--fg-1)' }}>18:40</b></span>
      </div>
    </div>
  );
}

function MkHero() {
  return (
    <section style={{ padding: 'clamp(48px,8vw,96px) 0' }}>
      <div style={{ ...mkWrap, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,440px),1fr))', gap: 'clamp(32px,5vw,64px)', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <h1 style={{ margin: 0, font: '700 clamp(40px,5.2vw,60px)/1.08 var(--font-ui)', letterSpacing: '-0.025em', color: 'var(--fg-1)', textWrap: 'balance' }}>Keep score, run tournaments and follow your club’s results.</h1>
          <p style={{ margin: 0, font: '400 19px/1.55 var(--font-ui)', color: 'var(--fg-2)', maxWidth: 540, textWrap: 'pretty' }}>FortyMM is a table-tennis app for players and organizers. Score matches from your phone, schedule a tournament across every table you have, and see results and ratings as they happen.</p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button style={mkPrimary}>Get the app</button>
            <button style={mkSecondary}>Run a tournament</button>
          </div>
          <p style={{ margin: 0, font: '400 15px var(--font-ui)', color: 'var(--fg-3)' }}>Free for players and clubs. No ads, no tracking.</p>
        </div>
        <MkScorePanel />
      </div>
    </section>
  );
}

function MkFeatures() {
  const items = [
    ['Score at the table', 'Large numbers, one tap per point and undo when you need it. Serve changes and game ends are tracked for you.'],
    ['Run the day', 'See which tables are free, who is resting and when the last match will finish. Conflicts come with a suggested fix.'],
    ['Follow your rating', 'Results update ratings straight away, with the change shown next to every match.'],
  ];
  return (
    <section style={{ borderTop: '1px solid var(--border-subtle)', padding: '64px 0' }}>
      <div style={mkWrap}>
        <h2 style={{ margin: '0 0 32px', font: '600 28px var(--font-ui)', color: 'var(--fg-1)' }}>What you can do</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 32 }}>
          {items.map(([t, d]) => (
            <div key={t} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3 style={{ margin: 0, font: '600 19px var(--font-ui)', color: 'var(--fg-1)' }}>{t}</h3>
              <p style={{ margin: 0, font: '400 16px/1.55 var(--font-ui)', color: 'var(--fg-2)' }}>{d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MkCommitments() {
  const items = ['FortyMM is free for players and clubs.', 'We don’t show ads.', 'We don’t sell or share your data, and we don’t use third-party tracking.', 'Every feature is available to everyone.'];
  return (
    <section style={{ borderTop: '1px solid var(--border-subtle)', padding: '64px 0' }}>
      <div style={{ ...mkWrap, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,320px),1fr))', gap: 32 }}>
        <h2 style={{ margin: 0, font: '600 28px var(--font-ui)', color: 'var(--fg-1)' }}>What we commit to</h2>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map(i => <li key={i} style={{ padding: '14px 0', borderBottom: '1px solid var(--border-subtle)', font: '400 17px/1.5 var(--font-ui)', color: 'var(--fg-1)' }}>{i}</li>)}
        </ul>
      </div>
    </section>
  );
}

function MkFooter() {
  return (
    <footer style={{ borderTop: '1px solid var(--border-subtle)', padding: '32px 0 48px' }}>
      <div style={{ ...mkWrap, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', font: '400 14px var(--font-ui)', color: 'var(--fg-3)' }}>
        <img src="../../assets/logo-mark.svg" alt="" style={{ height: 20 }} />
        <span>© 2026 FortyMM</span>
        <div style={{ flex: 1 }}></div>
        <a>iOS</a><a>Android</a><a>Privacy</a><a>Contact</a>
      </div>
    </footer>
  );
}

Object.assign(window, { MkNav, MkHero, MkScorePanel, MkFeatures, MkCommitments, MkFooter });
ReactDOM.createRoot(document.getElementById('root')).render(<div><MkNav /><MkHero /><MkFeatures /><MkCommitments /><MkFooter /></div>);
