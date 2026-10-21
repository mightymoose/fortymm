// iOS screens for FortyMM — uses IOSDevice primitives + custom dark FortyMM styling
// Four screens: Home feed, Match tracker, Bracket, Profile

const C = {
  ink950:'#0B0D12', ink900:'#11141B', ink800:'#171B24', ink700:'#1F2430',
  ink600:'#2A3040', ink500:'#3A4152',
  fg1:'#F7F8FB', fg2:'#E4E7EF', fg3:'#A9B0C2', muted:'#6B7283',
  ball:'#FF7A1A', ballDim:'#B94700',
  serve:'#00E29A', loss:'#FF4D6D',
};

function Screen({children, pad=true}) {
  return (
    <div style={{
      height:'100%', background:C.ink950, color:C.fg1,
      fontFamily:"'Space Grotesk', system-ui, sans-serif",
      overflowY:'auto', paddingBottom:100,
    }}>
      {children}
    </div>
  );
}

function TopBar({title, right}) {
  return (
    <div style={{
      padding:'62px 20px 12px', display:'flex', alignItems:'flex-end', justifyContent:'space-between',
      position:'sticky', top:0, background:'rgba(11,13,18,0.75)', backdropFilter:'blur(12px)',
      zIndex:5, borderBottom:`1px solid ${C.ink600}`,
    }}>
      <div style={{fontFamily:"'Bebas Neue', sans-serif", fontSize:34, letterSpacing:'0.02em', lineHeight:1, color:C.fg1}}>{title}</div>
      {right}
    </div>
  );
}

function TabBar({active='home', onTab}) {
  const tabs = [
    {k:'home', l:'Matches'},
    {k:'find', l:'Find'},
    {k:'log', l:'+', primary:true},
    {k:'bracket', l:'Draws'},
    {k:'profile', l:'You'},
  ];
  return (
    <div style={{
      position:'absolute', bottom:0, left:0, right:0, zIndex:40,
      padding:'10px 12px 30px', background:'rgba(11,13,18,0.85)',
      backdropFilter:'blur(16px)', borderTop:`1px solid ${C.ink600}`,
      display:'flex', justifyContent:'space-around',
    }}>
      {tabs.map(t=>(
        <div key={t.k} onClick={()=>onTab&&onTab(t.k)} style={{
          flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:4,
          cursor:'pointer',
        }}>
          {t.primary ? (
            <div style={{
              width:48, height:48, borderRadius:'50%', background:C.ball,
              color:C.ink950, fontSize:26, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center',
              boxShadow:'0 8px 20px rgba(255,122,26,0.45)', marginTop:-12,
            }}>+</div>
          ) : (
            <>
              <div style={{
                width:22, height:22, borderRadius: active===t.k?'50%':'4px',
                background: active===t.k?C.ball:C.ink700,
                border: active===t.k?'none':`1.5px solid ${C.ink500}`,
              }}/>
              <div style={{
                font:`600 10px 'Space Grotesk', sans-serif`,
                letterSpacing:'0.1em', textTransform:'uppercase',
                color: active===t.k?C.ball:C.fg3,
              }}>{t.l}</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// HOME screen — your matches feed
function HomeScreen() {
  return (
    <Screen>
      <TopBar title="Matches" right={<div style={{width:36,height:36,borderRadius:'50%',background:C.ink700,border:`1px solid ${C.ink500}`}}/>}/>
      <div style={{padding:'20px 16px 0'}}>
        <div style={{font:'600 11px var(--font-mono)', letterSpacing:'0.14em', color:C.fg3, textTransform:'uppercase', marginBottom:12}}>● Live near you</div>
        <LiveMatchCard/>
        <div style={{font:'600 11px var(--font-mono)', letterSpacing:'0.14em', color:C.fg3, textTransform:'uppercase', margin:'28px 0 12px'}}>Your upcoming</div>
        <UpcomingMatch/>
        <UpcomingMatch opponent="Silva, R." rating={1985} time="Tomorrow · 19:00" club="Riverside TT"/>
        <div style={{font:'600 11px var(--font-mono)', letterSpacing:'0.14em', color:C.fg3, textTransform:'uppercase', margin:'28px 0 12px'}}>Recent</div>
        <RecentMatch/>
      </div>
    </Screen>
  );
}

function LiveMatchCard() {
  return (
    <div style={{
      background:C.ink800, border:`1px solid rgba(0,226,154,0.35)`, borderRadius:14,
      padding:16, boxShadow:'0 0 0 1px rgba(0,226,154,0.12), 0 0 24px rgba(0,226,154,0.1)',
    }}>
      <div style={{display:'flex', justifyContent:'space-between', marginBottom:12}}>
        <span style={{display:'inline-flex',gap:6,alignItems:'center',font:`600 10px 'JetBrains Mono'`, letterSpacing:'0.14em',color:C.serve}}>
          <span style={{width:7,height:7,borderRadius:'50%',background:C.serve,boxShadow:`0 0 8px ${C.serve}`}}/>LIVE · GAME 3
        </span>
        <span style={{font:`500 10px 'JetBrains Mono'`, color:C.fg3, letterSpacing:'0.1em'}}>COURT 3</span>
      </div>
      <IOSPlayerRow name="Nguyen, T." seed="1" score={11} win/>
      <div style={{height:1,background:C.ink600,margin:'10px 0'}}/>
      <IOSPlayerRow name="Okafor, D." seed="8" score={8}/>
    </div>
  );
}

function IOSPlayerRow({name, seed, score, win}) {
  return (
    <div style={{display:'flex', alignItems:'center', gap:12}}>
      <div style={{
        width:36, height:36, borderRadius:'50%',
        background: win?'linear-gradient(135deg,#FF7A1A,#B94700)':C.ink700,
        boxShadow: win?`0 0 0 2px ${C.ball}`:'none',
        display:'flex',alignItems:'center',justifyContent:'center',
        font:'700 13px sans-serif', color:win?'#fff':C.fg2,
      }}>{name.split(',')[0].slice(0,2).toUpperCase()}</div>
      <div style={{flex:1}}>
        <div style={{font:'600 15px sans-serif', color:win?C.serve:C.fg1}}>{name}</div>
        <div style={{font:`500 10px 'JetBrains Mono'`, color:C.fg3, letterSpacing:'0.1em'}}>SEED {seed}</div>
      </div>
      <div style={{font:`700 32px 'JetBrains Mono'`, fontVariantNumeric:'tabular-nums', color:win?C.serve:C.fg1, lineHeight:1}}>{score}</div>
    </div>
  );
}

function UpcomingMatch({opponent='Tran, L.', rating=2010, time='Today · 20:30', club='Downtown TT Club'}) {
  return (
    <div style={{
      background:C.ink800, border:`1px solid ${C.ink600}`, borderRadius:12,
      padding:14, marginBottom:8, display:'flex',gap:12, alignItems:'center',
    }}>
      <div style={{width:40, height:40, borderRadius:'50%', background:C.ink700, display:'flex',alignItems:'center',justifyContent:'center',font:'700 14px sans-serif', color:C.fg2}}>
        {opponent.slice(0,2).toUpperCase()}
      </div>
      <div style={{flex:1}}>
        <div style={{font:'600 15px sans-serif',color:C.fg1}}>{opponent}</div>
        <div style={{font:'400 12px sans-serif', color:C.fg3}}>{time} · {club}</div>
      </div>
      <div style={{
        font:`700 12px 'JetBrains Mono'`, color:C.ball, background:'rgba(255,122,26,0.14)',
        padding:'4px 10px', borderRadius:999,
      }}>★ {rating}</div>
    </div>
  );
}

function RecentMatch() {
  return (
    <div style={{
      background:C.ink800, border:`1px solid ${C.ink600}`, borderRadius:12,
      padding:14, display:'flex',gap:12, alignItems:'center',
    }}>
      <div style={{width:40, height:40, borderRadius:'50%',background:'linear-gradient(135deg,#00E29A,#009968)',display:'flex',alignItems:'center',justifyContent:'center',font:'700 14px sans-serif',color:C.ink950}}>W</div>
      <div style={{flex:1}}>
        <div style={{font:'600 15px sans-serif',color:C.fg1}}>def. Patel, M.  <span style={{color:C.fg3, fontFamily:'JetBrains Mono', fontSize:13}}>3–1</span></div>
        <div style={{font:'400 12px sans-serif', color:C.fg3}}>Yesterday · Singles · +12 rating</div>
      </div>
      <div style={{font:`700 14px 'JetBrains Mono'`, color:C.serve}}>+12</div>
    </div>
  );
}

// BRACKET screen
function BracketScreen() {
  return (
    <Screen>
      <TopBar title="Spring Open" right={<div style={{font:`500 11px 'JetBrains Mono'`,color:C.fg3,letterSpacing:'0.14em'}}>R16 · LIVE</div>}/>
      <div style={{padding:'16px'}}>
        <div style={{display:'flex',gap:8,marginBottom:16,overflowX:'auto'}}>
          {['R32','R16','QF','SF','F'].map((r,i)=>(
            <div key={r} style={{
              padding:'6px 14px', borderRadius:999, font:`600 11px 'Space Grotesk'`,
              letterSpacing:'0.08em', whiteSpace:'nowrap',
              background: i===1?C.ball:'transparent',
              color: i===1?C.ink950:C.fg2,
              border: i===1?'none':`1px solid ${C.ink500}`,
            }}>{r}</div>
          ))}
        </div>
        {[
          ['Nguyen, T.','Silva, R.',11,7,true],
          ['Okafor, D.','Johansen, A.',11,9,true],
          ['Tran, L.','Patel, M.',8,11,false],
          ['Chen, W.','Park, J.',null,null,null],
        ].map((m,i)=>(
          <MiniMatch key={i} m={m}/>
        ))}
      </div>
    </Screen>
  );
}

function MiniMatch({m}) {
  const [a,b,sa,sb,aWin] = m;
  const pending = sa===null;
  return (
    <div style={{
      background:C.ink800, border:`1px solid ${C.ink600}`, borderRadius:10, padding:12, marginBottom:8,
    }}>
      <MiniRow n={a} s={sa} win={aWin===true} pending={pending}/>
      <div style={{height:1, background:C.ink600, margin:'8px 0'}}/>
      <MiniRow n={b} s={sb} win={aWin===false} pending={pending}/>
    </div>
  );
}

function MiniRow({n,s,win,pending}) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:10}}>
      <div style={{flex:1,font:'500 14px sans-serif', color:win?C.serve:(pending?C.fg3:C.fg1)}}>{n}</div>
      <div style={{font:`700 15px 'JetBrains Mono'`, color:win?C.serve:(pending?C.fg3:C.fg2), fontVariantNumeric:'tabular-nums'}}>{pending?'—':s}</div>
    </div>
  );
}

// PROFILE screen
function ProfileScreen() {
  return (
    <Screen>
      <div style={{paddingTop:62}}/>
      <div style={{padding:'20px 20px 0', display:'flex',flexDirection:'column',alignItems:'center',gap:12}}>
        <div style={{
          width:88, height:88, borderRadius:'50%',
          background:'linear-gradient(135deg,#FF7A1A,#B94700)',
          boxShadow:`0 0 0 3px ${C.ball}, 0 0 40px rgba(255,122,26,0.35)`,
          display:'flex',alignItems:'center',justifyContent:'center',
          font:'700 30px sans-serif', color:'#fff',
        }}>YO</div>
        <div style={{fontFamily:"'Bebas Neue'", fontSize:34, letterSpacing:'0.02em',color:C.fg1, lineHeight:1}}>You</div>
        <div style={{font:`500 11px 'JetBrains Mono'`, color:C.fg3, letterSpacing:'0.14em'}}>Downtown TT Club · Since Mar 2025</div>
      </div>
      <div style={{padding:'24px 16px 0', display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8}}>
        <Stat v="1,847" l="Rating"/>
        <Stat v="42" l="Matches"/>
        <Stat v="71%" l="Win rate"/>
      </div>
      <div style={{padding:'24px 16px 0'}}>
        <div style={{font:'600 11px var(--font-mono)', letterSpacing:'0.14em', color:C.fg3, textTransform:'uppercase', marginBottom:10}}>Rating history</div>
        <div style={{background:C.ink800, border:`1px solid ${C.ink600}`, borderRadius:12, padding:16, height:140, position:'relative'}}>
          <svg width="100%" height="100%" viewBox="0 0 300 100" preserveAspectRatio="none">
            <polyline points="0,70 30,65 60,68 90,55 120,58 150,45 180,48 210,35 240,38 270,25 300,22" fill="none" stroke={C.ball} strokeWidth="2"/>
            <polyline points="0,70 30,65 60,68 90,55 120,58 150,45 180,48 210,35 240,38 270,25 300,22 300,100 0,100" fill="rgba(255,122,26,0.12)"/>
          </svg>
        </div>
      </div>
    </Screen>
  );
}

function Stat({v,l}) {
  return (
    <div style={{background:C.ink800,border:`1px solid ${C.ink600}`,borderRadius:10, padding:'14px 12px',textAlign:'center'}}>
      <div style={{font:`700 22px 'JetBrains Mono'`, fontVariantNumeric:'tabular-nums', color:C.fg1}}>{v}</div>
      <div style={{font:`600 10px 'Space Grotesk'`, letterSpacing:'0.14em', color:C.fg3, textTransform:'uppercase', marginTop:2}}>{l}</div>
    </div>
  );
}

Object.assign(window, {
  Screen, TopBar, TabBar, HomeScreen, BracketScreen, ProfileScreen, LiveMatchCard,
});


// ---- App mount (moved from index.html) ----
function Phone({children, tab='home', onTab}) {
    return (
      <div className="phone">
        <div style={{width:372, height:790, borderRadius:48, overflow:'hidden', position:'relative', background:'#000', boxShadow:'0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.5)'}}>
          <div style={{position:'absolute', top:10, left:'50%', transform:'translateX(-50%)', width:120, height:34, borderRadius:22, background:'#000', zIndex:60}}/>
          <div style={{position:'absolute', top:16, left:26, fontFamily:'-apple-system, system-ui', fontWeight:600, fontSize:15, color:'#fff', zIndex:30}}>9:41</div>
          <div style={{position:'absolute', top:16, right:26, display:'flex', gap:6, zIndex:30}}>
            <div style={{width:16,height:11,background:'#fff',borderRadius:1}}/>
            <div style={{width:22,height:11,border:'1px solid #fff',borderRadius:3}}/>
          </div>
          <div style={{width:'100%',height:'100%'}}>{children}</div>
          <TabBar active={tab} onTab={onTab}/>
        </div>
      </div>
    );
  }

  function App() {
    const [tab, setTab] = React.useState('home');
    const screens = {
      home: <HomeScreen/>,
      bracket: <BracketScreen/>,
      profile: <ProfileScreen/>,
      find: <HomeScreen/>,
      log: <HomeScreen/>,
    };
    return (
      <div style={{display:'flex', flexDirection:'column', alignItems:'center'}}>
        <div className="tabs">
          <button className={"tab "+(tab==='home'?'on':'')} onClick={()=>setTab('home')}>Matches</button>
          <button className={"tab "+(tab==='bracket'?'on':'')} onClick={()=>setTab('bracket')}>Bracket</button>
          <button className={"tab "+(tab==='profile'?'on':'')} onClick={()=>setTab('profile')}>Profile</button>
        </div>
        <Phone tab={tab} onTab={setTab}>
          {screens[tab]}
        </Phone>
      </div>
    );
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
