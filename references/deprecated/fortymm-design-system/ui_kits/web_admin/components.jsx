// Web admin dashboard components for FortyMM tournament control
const C = {ink950:'#0B0D12',ink900:'#11141B',ink800:'#171B24',ink700:'#1F2430',ink600:'#2A3040',ink500:'#3A4152',fg1:'#F7F8FB',fg2:'#E4E7EF',fg3:'#A9B0C2',ball:'#FF7A1A',serve:'#00E29A',loss:'#FF4D6D',warn:'#FFC43D'};

function Sidebar({active='courts'}) {
  const items=[['overview','Overview'],['draws','Draws'],['courts','Courts · Live'],['players','Players'],['schedule','Schedule'],['solver','SMT solver'],['reports','Reports'],['settings','Settings']];
  return (
    <aside style={{width:220,background:C.ink900,borderRight:`1px solid ${C.ink600}`,padding:'18px 0',display:'flex',flexDirection:'column',gap:2}}>
      <div style={{padding:'0 18px 18px',display:'flex',alignItems:'center',gap:10,borderBottom:`1px solid ${C.ink600}`,marginBottom:12}}>
        <svg width="28" height="28" viewBox="0 0 80 80"><defs><radialGradient id="sg" cx="35%" cy="35%" r="65%"><stop offset="0%" stopColor="#FFB57A"/><stop offset="55%" stopColor="#FF7A1A"/><stop offset="100%" stopColor="#B94700"/></radialGradient></defs><circle cx="40" cy="40" r="36" fill="url(#sg)"/></svg>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:'0.04em',color:C.fg1}}>FORTYMM<span style={{color:C.ball}}>.</span></div>
      </div>
      <div style={{padding:'0 14px 8px',font:`600 10px 'Space Grotesk'`,letterSpacing:'0.14em',color:C.fg3,textTransform:'uppercase'}}>Spring Open</div>
      {items.map(([k,l])=>(
        <div key={k} style={{margin:'0 10px',padding:'9px 12px',borderRadius:8,background:active===k?'rgba(255,122,26,0.12)':'transparent',color:active===k?C.ball:C.fg2,font:'500 13px sans-serif',cursor:'pointer',borderLeft:active===k?`2px solid ${C.ball}`:'2px solid transparent'}}>{l}</div>
      ))}
      <div style={{flex:1}}/>
      <div style={{margin:'0 14px',padding:12,background:C.ink800,border:`1px solid ${C.ink600}`,borderRadius:8}}>
        <div style={{font:`600 10px 'JetBrains Mono'`,color:C.serve,letterSpacing:'0.14em',marginBottom:4}}>● SOLVER READY</div>
        <div style={{font:'500 12px sans-serif',color:C.fg2}}>12 constraints · 0 conflicts</div>
      </div>
    </aside>
  );
}

function ActionBar() {
  return (
    <div style={{height:56,borderBottom:`1px solid ${C.ink600}`,display:'flex',alignItems:'center',padding:'0 24px',gap:12,background:C.ink950}}>
      <div style={{font:'600 16px sans-serif',color:C.fg1}}>Courts · Live</div>
      <div style={{display:'inline-flex',alignItems:'center',gap:6,font:`600 10px 'JetBrains Mono'`,color:C.serve,letterSpacing:'0.14em',marginLeft:12}}>
        <span style={{width:7,height:7,borderRadius:'50%',background:C.serve,boxShadow:`0 0 8px ${C.serve}`}}/>4 MATCHES LIVE
      </div>
      <div style={{flex:1}}/>
      <button style={btnGhost}>Call next</button>
      <button style={btnGhost}>Pause draw</button>
      <button style={btnPrimary}>+ New match</button>
    </div>
  );
}
const btnBase={font:"600 13px 'Space Grotesk'",height:36,padding:'0 14px',borderRadius:8,border:'1px solid transparent',cursor:'pointer'};
const btnGhost={...btnBase,background:'transparent',color:C.fg2,borderColor:C.ink500};
const btnPrimary={...btnBase,background:C.ball,color:C.ink950};

function StatStrip() {
  const stats=[['Matches done','142'],['Live now','4'],['Up next','8'],['Avg court util.','92%'],['Behind schedule','0']];
  return (
    <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:12,padding:20,borderBottom:`1px solid ${C.ink600}`}}>
      {stats.map(([l,v])=>(
        <div key={l} style={{background:C.ink800,border:`1px solid ${C.ink600}`,borderRadius:10,padding:'14px 16px'}}>
          <div style={{font:`600 10px 'Space Grotesk'`,letterSpacing:'0.14em',color:C.fg3,textTransform:'uppercase'}}>{l}</div>
          <div style={{font:`700 26px 'JetBrains Mono'`,fontVariantNumeric:'tabular-nums',color:C.fg1,marginTop:4}}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function CourtGrid() {
  const courts=[
    {n:1,a:'Nguyen, T.',b:'Silva, R.',sa:11,sb:7,g:3,live:true,w:'a'},
    {n:2,a:'Okafor, D.',b:'Johansen, A.',sa:9,sb:11,g:2,live:true,w:'b'},
    {n:3,a:'Tran, L.',b:'Patel, M.',sa:11,sb:8,g:4,live:true,w:'a'},
    {n:4,a:'Chen, W.',b:'Park, J.',sa:6,sb:4,g:1,live:true,w:null},
    {n:5,a:'—',b:'—',next:'Kim, H. vs Ali, R.'},
    {n:6,a:'—',b:'—',next:'Rossi, G. vs Dubois, C.'},
  ];
  return (
    <div style={{padding:20,display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14}}>
      {courts.map(c=><CourtCard key={c.n} c={c}/>)}
    </div>
  );
}

function CourtCard({c}) {
  if(!c.live) return (
    <div style={{background:C.ink800,border:`1px dashed ${C.ink600}`,borderRadius:12,padding:18,minHeight:160,display:'flex',flexDirection:'column',gap:8,justifyContent:'space-between'}}>
      <div style={{display:'flex',justifyContent:'space-between'}}>
        <div style={{font:`700 18px 'Bebas Neue'`,letterSpacing:'0.05em',color:C.fg1}}>COURT {c.n}</div>
        <div style={{font:`600 10px 'JetBrains Mono'`,color:C.fg3,letterSpacing:'0.14em'}}>OPEN</div>
      </div>
      <div style={{font:'400 13px sans-serif',color:C.fg3}}>Next up: <span style={{color:C.fg1,fontWeight:500}}>{c.next}</span></div>
      <button style={{...btnBase,background:'transparent',border:`1px solid ${C.ball}`,color:C.ball}}>Call to court</button>
    </div>
  );
  return (
    <div style={{background:C.ink800,border:`1px solid ${c.live?'rgba(0,226,154,0.3)':C.ink600}`,borderRadius:12,padding:18,minHeight:160,boxShadow:c.live?'0 0 20px rgba(0,226,154,0.08)':'none'}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:12}}>
        <div style={{font:`700 18px 'Bebas Neue'`,letterSpacing:'0.05em',color:C.fg1}}>COURT {c.n}</div>
        <div style={{display:'inline-flex',alignItems:'center',gap:5,font:`600 10px 'JetBrains Mono'`,color:C.serve,letterSpacing:'0.14em'}}>
          <span style={{width:6,height:6,borderRadius:'50%',background:C.serve,boxShadow:`0 0 6px ${C.serve}`}}/>LIVE · G{c.g}
        </div>
      </div>
      <CourtRow n={c.a} s={c.sa} win={c.w==='a'}/>
      <div style={{height:1,background:C.ink600,margin:'8px 0'}}/>
      <CourtRow n={c.b} s={c.sb} win={c.w==='b'}/>
    </div>
  );
}

function CourtRow({n,s,win}) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:10}}>
      <div style={{flex:1,font:'500 14px sans-serif',color:win?C.serve:C.fg1}}>{n}</div>
      <div style={{font:`700 24px 'JetBrains Mono'`,fontVariantNumeric:'tabular-nums',color:win?C.serve:C.fg2,lineHeight:1}}>{s}</div>
    </div>
  );
}

function SolverPanel() {
  return (
    <div style={{padding:20,borderTop:`1px solid ${C.ink600}`,background:C.ink900}}>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
        <div style={{font:`700 20px 'Bebas Neue'`,letterSpacing:'0.03em',color:C.fg1}}>SMT SOLVER</div>
        <div style={{font:`600 10px 'JetBrains Mono'`,color:C.serve,letterSpacing:'0.14em'}}>● OPTIMAL · 234ms</div>
        <div style={{flex:1}}/>
        <button style={btnGhost}>Re-solve</button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:14}}>
        <pre style={{background:C.ink950,border:`1px solid ${C.ink600}`,borderRadius:8,padding:14,margin:0,font:`500 12px 'JetBrains Mono'`,color:C.fg2,overflowX:'auto'}}>{`constraints:
  · no player back-to-back  (all 64 players)
  · 15min rest minimum     (hard)
  · court rotation balance (soft, w=3)
  · umpire availability    (9 active)

objective: minimize makespan
status: sat | bound: 4h 12m | actual: 4h 14m`}</pre>
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          <SolverStat l="Constraints" v="12"/>
          <SolverStat l="Variables" v="1,248"/>
          <SolverStat l="Conflicts" v="0" good/>
          <SolverStat l="Horizon" v="4h 14m"/>
        </div>
      </div>
    </div>
  );
}

function SolverStat({l,v,good}) {
  return (
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 14px',background:C.ink800,border:`1px solid ${C.ink600}`,borderRadius:8}}>
      <span style={{font:`500 12px 'Space Grotesk'`,color:C.fg3,letterSpacing:'0.08em',textTransform:'uppercase'}}>{l}</span>
      <span style={{font:`700 14px 'JetBrains Mono'`,color:good?C.serve:C.fg1}}>{v}</span>
    </div>
  );
}

Object.assign(window, { Sidebar, ActionBar, StatStrip, CourtGrid, SolverPanel });


// ---- App mount (moved from index.html) ----
function App(){return (
    <div style={{display:'flex',height:'100vh',width:'100vw'}}>
      <Sidebar active="courts"/>
      <main style={{flex:1,display:'flex',flexDirection:'column',overflow:'auto'}}>
        <ActionBar/>
        <StatStrip/>
        <CourtGrid/>
        <SolverPanel/>
      </main>
    </div>
  );}
  ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
