// Marketing site components for FortyMM
// Uses tokens from ../../colors_and_type.css

function Nav() {
  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', gap: 32,
      padding: '18px 40px', background: 'rgba(11,13,18,0.72)',
      backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
      borderBottom: '1px solid var(--ink-600)',
    }}>
      <Logo size={28} />
      <a style={navLink}>Product</a>
      <a style={navLink}>Tournaments</a>
      <a style={navLink}>Clubs</a>
      <a style={navLink}>Manifesto</a>
      <div style={{flex: 1}} />
      <a style={navLink}>Sign in</a>
      <button className="btn-primary">Get the app</button>
    </nav>
  );
}
const navLink = {
  font: '500 14px var(--font-ui)', color: 'var(--fg-2)',
  textDecoration: 'none', cursor: 'pointer',
};

function Logo({size=32}) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:10}}>
      <svg width={size} height={size} viewBox="0 0 80 80">
        <defs><radialGradient id="lg" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#FFB57A"/><stop offset="55%" stopColor="#FF7A1A"/><stop offset="100%" stopColor="#B94700"/>
        </radialGradient></defs>
        <circle cx="40" cy="40" r="36" fill="url(#lg)"/>
        <ellipse cx="30" cy="28" rx="10" ry="6" fill="#FFF" fillOpacity="0.22"/>
      </svg>
      <span style={{fontFamily:"'Bebas Neue', sans-serif", fontSize: size*0.95, letterSpacing:'0.04em', color:'var(--fg-1)', lineHeight:1}}>
        FORTYMM<span style={{color:'var(--ball-500)'}}>.</span>
      </span>
    </div>
  );
}

function Hero() {
  return (
    <section style={{
      position:'relative', padding:'80px 40px 120px',
      overflow:'hidden',
    }}>
      <div className="fortymm-grid-bg" style={{
        position:'absolute', inset:0, opacity:0.6,
        maskImage:'radial-gradient(ellipse 70% 50% at 70% 30%, black, transparent)',
        WebkitMaskImage:'radial-gradient(ellipse 70% 50% at 70% 30%, black, transparent)',
      }}/>
      <div style={{
        position:'absolute', top:'10%', right:'5%', width:500, height:500,
        background:'radial-gradient(circle, rgba(255,122,26,0.18), transparent 70%)',
        pointerEvents:'none',
      }}/>
      <div style={{position:'relative', maxWidth:1180, margin:'0 auto', display:'grid', gridTemplateColumns:'1.1fr 0.9fr', gap:64, alignItems:'center'}}>
        <div>
          <div className="overline" style={{color:'var(--ball-500)', marginBottom:20}}>
            ● Free forever · No ads · No tracking
          </div>
          <h1 style={{
            fontFamily:"'Bebas Neue', sans-serif", fontSize:112, lineHeight:0.92,
            letterSpacing:'0.01em', color:'var(--fg-1)', margin:'0 0 24px',
            textTransform:'uppercase',
          }}>
            Play more.<br/>
            <span style={{color:'var(--ball-500)'}}>Pay never.</span>
          </h1>
          <p style={{fontSize:20, lineHeight:1.5, color:'var(--fg-2)', maxWidth:520, margin:'0 0 32px'}}>
            The table-tennis app made by players, for players. Track your matches, join tournaments, find opponents. No premium tier. No cookie banners. No horse shit.
          </p>
          <div style={{display:'flex', gap:12}}>
            <button className="btn-primary btn-lg">Download for iOS</button>
            <button className="btn-secondary btn-lg">Download for Android</button>
          </div>
          <div style={{marginTop:24, display:'flex', gap:28, alignItems:'center'}}>
            <Stat n="12,480" l="active players" />
            <Stat n="340" l="clubs" />
            <Stat n="1,102" l="tournaments run" />
          </div>
        </div>
        <HeroScoreboard />
      </div>
    </section>
  );
}

function Stat({n,l}) {
  return (
    <div>
      <div style={{fontFamily:'var(--font-mono)', fontSize:22, fontWeight:700, color:'var(--fg-1)', fontVariantNumeric:'tabular-nums'}}>{n}</div>
      <div style={{fontSize:12, color:'var(--fg-3)', letterSpacing:'0.1em', textTransform:'uppercase'}}>{l}</div>
    </div>
  );
}

function HeroScoreboard() {
  return (
    <div style={{
      background:'var(--ink-800)', border:'1px solid var(--ink-600)',
      borderRadius:16, padding:28, boxShadow:'0 24px 60px rgba(0,0,0,0.5)',
    }}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20}}>
        <span style={{display:'inline-flex', alignItems:'center', gap:8, fontFamily:'var(--font-mono)', fontSize:11, letterSpacing:'0.14em', color:'var(--serve-500)'}}>
          <span className="ball-dot ball-dot--live"/>LIVE · GAME 4
        </span>
        <span style={{fontFamily:'var(--font-mono)', fontSize:11, color:'var(--fg-3)', letterSpacing:'0.1em'}}>COURT 3 · 19:42</span>
      </div>
      <Player name="Nguyen, T." seed="1" score={11} win />
      <div style={{height:1, background:'var(--ink-600)', margin:'14px 0'}}/>
      <Player name="Okafor, D." seed="8" score={8} />
      <div style={{marginTop:24, display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8}}>
        {[[11,6],[9,11],[11,8],[11,8]].map((g,i)=>(
          <GameBox key={i} g={g} live={i===3}/>
        ))}
      </div>
    </div>
  );
}

function Player({name, seed, score, win}) {
  return (
    <div style={{display:'flex', alignItems:'center', gap:14}}>
      <div style={{
        width:40, height:40, borderRadius:'50%',
        background: win?'linear-gradient(135deg,#FF7A1A,#B94700)':'var(--ink-700)',
        boxShadow: win?'0 0 0 2px var(--ball-500)':'none',
        display:'flex', alignItems:'center', justifyContent:'center',
        font:'700 14px var(--font-ui)', color: win?'#fff':'var(--fg-2)',
      }}>{name.split(',')[0].slice(0,2).toUpperCase()}</div>
      <div style={{flex:1}}>
        <div style={{font:'600 16px var(--font-ui)', color: win?'var(--serve-500)':'var(--fg-1)'}}>{name}</div>
        <div style={{font:'500 11px var(--font-mono)', color:'var(--fg-3)', letterSpacing:'0.1em'}}>SEED {seed} · 2145</div>
      </div>
      <div style={{
        font:'700 44px var(--font-mono)', fontVariantNumeric:'tabular-nums',
        color: win?'var(--serve-500)':'var(--fg-1)', lineHeight:1,
      }}>{score}</div>
    </div>
  );
}

function GameBox({g, live}) {
  return (
    <div style={{
      background:'var(--ink-900)', border: live?'1px solid rgba(0,226,154,0.4)':'1px solid var(--ink-600)',
      borderRadius:8, padding:'10px 8px', textAlign:'center',
    }}>
      <div style={{font:'700 18px var(--font-mono)', color: g[0]>g[1]?'var(--serve-500)':'var(--fg-2)'}}>{g[0]}</div>
      <div style={{height:1, background:'var(--ink-600)', margin:'4px 0'}}/>
      <div style={{font:'700 18px var(--font-mono)', color: g[1]>g[0]?'var(--serve-500)':'var(--fg-2)'}}>{g[1]}</div>
    </div>
  );
}

function Manifesto() {
  return (
    <section style={{padding:'100px 40px', background:'var(--ink-900)', borderTop:'1px solid var(--ink-600)', borderBottom:'1px solid var(--ink-600)'}}>
      <div style={{maxWidth:900, margin:'0 auto'}}>
        <div className="overline" style={{color:'var(--ball-500)', marginBottom:16}}>● Manifesto</div>
        <h2 style={{fontFamily:"'Bebas Neue', sans-serif", fontSize:64, lineHeight:1, letterSpacing:'0.01em', color:'var(--fg-1)', margin:'0 0 40px', textTransform:'uppercase'}}>
          For the love of the game.
        </h2>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:32}}>
          <Promise n="01" t="No ads. Not now, not ever." d="Every other sports-tracker app ends up covered in Draftkings banners. Ours won't. That's a commitment, not a roadmap item." />
          <Promise n="02" t="No premium tier." d="Every feature works for everyone. No unlocks, no trials, no 'upgrade to see full bracket' nonsense." />
          <Promise n="03" t="We don't sell your data." d="No trackers, no third-party analytics, no cookie consent theater. We keep what the app needs to work. Nothing else." />
          <Promise n="04" t="The math is quiet. The rallies are loud." d="We use an SMT solver to pack tournament schedules — fewer back-to-backs, smarter court assignments. You'll never see it. You'll just play more." />
        </div>
      </div>
    </section>
  );
}

function Promise({n,t,d}) {
  return (
    <div>
      <div style={{fontFamily:'var(--font-mono)', fontSize:13, fontWeight:700, color:'var(--ball-500)', letterSpacing:'0.1em', marginBottom:10}}>{n}</div>
      <h3 style={{font:'600 22px var(--font-ui)', color:'var(--fg-1)', margin:'0 0 10px', letterSpacing:'-0.01em'}}>{t}</h3>
      <p style={{font:'400 15px/1.55 var(--font-ui)', color:'var(--fg-2)', margin:0}}>{d}</p>
    </div>
  );
}

function Footer() {
  return (
    <footer style={{padding:'60px 40px 40px', borderTop:'1px solid var(--ink-600)'}}>
      <div style={{maxWidth:1180, margin:'0 auto', display:'flex', gap:60, flexWrap:'wrap'}}>
        <div style={{flex:'0 0 280px'}}>
          <Logo size={24}/>
          <p style={{font:'400 13px/1.55 var(--font-ui)', color:'var(--fg-3)', margin:'16px 0 0'}}>
            Made by players, in basements and rec centers. © 2026 FortyMM.
          </p>
        </div>
        <FooterCol h="Product" items={['iOS','Android','Spectator']}/>
        <FooterCol h="Tournaments" items={['Run one','Find one','SMT solver']}/>
        <FooterCol h="Community" items={['Discord','Clubs','Open-source']}/>
        <FooterCol h="Never" items={['Ads','Tracking','Premium']}/>
      </div>
    </footer>
  );
}

function FooterCol({h, items}) {
  return (
    <div>
      <div className="overline" style={{marginBottom:14}}>{h}</div>
      {items.map(i=>(
        <div key={i} style={{font:'500 14px/2 var(--font-ui)', color:'var(--fg-2)', cursor:'pointer'}}>{i}</div>
      ))}
    </div>
  );
}

Object.assign(window, { Nav, Logo, Hero, Manifesto, Footer });


// ---- App mount (moved from index.html) ----
function App() {
    return (
      <div>
        <Nav/>
        <Hero/>
        <Manifesto/>
        <Footer/>
      </div>
    );
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
