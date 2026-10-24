// Spectator public bracket view — full-bleed, shareable, readable from 10 feet
const C = {ink950:'#0B0D12',ink900:'#11141B',ink800:'#171B24',ink700:'#1F2430',ink600:'#2A3040',ink500:'#3A4152',fg1:'#F7F8FB',fg2:'#E4E7EF',fg3:'#A9B0C2',ball:'#FF7A1A',serve:'#00E29A'};

function SpecHeader() {
  return (
    <header style={{padding:'24px 40px',display:'flex',alignItems:'center',gap:20,borderBottom:`1px solid ${C.ink600}`,background:'rgba(11,13,18,0.8)',backdropFilter:'blur(12px)',position:'sticky',top:0,zIndex:5}}>
      <div style={{display:'flex',alignItems:'center',gap:10}}>
        <svg width="30" height="30" viewBox="0 0 80 80"><defs><radialGradient id="sh" cx="35%" cy="35%" r="65%"><stop offset="0%" stopColor="#FFB57A"/><stop offset="55%" stopColor="#FF7A1A"/><stop offset="100%" stopColor="#B94700"/></radialGradient></defs><circle cx="40" cy="40" r="36" fill="url(#sh)"/></svg>
        <span style={{fontFamily:"'Bebas Neue'",fontSize:24,letterSpacing:'0.04em',color:C.fg1}}>FORTYMM<span style={{color:C.ball}}>.</span></span>
      </div>
      <div style={{height:24,width:1,background:C.ink600,margin:'0 8px'}}/>
      <div>
        <div style={{font:"700 22px 'Space Grotesk'",color:C.fg1,letterSpacing:'-0.01em'}}>Spring Open 2026</div>
        <div style={{font:"500 12px 'JetBrains Mono'",color:C.fg3,letterSpacing:'0.1em'}}>DAY 2 · 64 PLAYERS · LIVE</div>
      </div>
      <div style={{flex:1}}/>
      <div style={{display:'inline-flex',alignItems:'center',gap:8,padding:'8px 14px',borderRadius:999,background:'rgba(0,226,154,0.12)',border:'1px solid rgba(0,226,154,0.3)'}}>
        <span style={{width:8,height:8,borderRadius:'50%',background:C.serve,boxShadow:`0 0 10px ${C.serve}`,animation:'p 1.4s infinite'}}/>
        <span style={{font:"600 12px 'JetBrains Mono'",color:C.serve,letterSpacing:'0.14em'}}>4 LIVE</span>
      </div>
      <button style={{font:"600 13px 'Space Grotesk'",height:38,padding:'0 18px',borderRadius:8,background:'transparent',border:`1px solid ${C.ink500}`,color:C.fg1,cursor:'pointer'}}>Share</button>
      <style>{`@keyframes p{0%,100%{opacity:1}50%{opacity:0.5}}`}</style>
    </header>
  );
}

function Bracket() {
  const rounds = [
    {name:'R16', matches:[
      ['Nguyen, T.',1,'Silva, R.',16,11,7,'a','done'],
      ['Kim, H.',8,'Dubois, C.',9,11,6,'a','done'],
      ['Okafor, D.',5,'Johansen, A.',12,9,11,'b','live','9-11, game 3'],
      ['Patel, M.',4,'Park, J.',13,null,null,null,'next'],
      ['Tran, L.',3,'Rossi, G.',14,11,8,'a','live','11-8, game 4'],
      ['Chen, W.',6,'Ali, R.',11,null,null,null,'next'],
      ['Ahmed, I.',7,'Hansen, M.',10,null,null,null,'scheduled'],
      ['Tanaka, Y.',2,'Müller, F.',15,null,null,null,'scheduled'],
    ]},
    {name:'QF', matches:[['W1',null,'W2',null,null,null,null,'pending']]},
    {name:'SF', matches:[['',null,'',null,null,null,null,'pending']]},
  ];
  return (
    <div style={{padding:40,display:'flex',gap:32,overflowX:'auto',alignItems:'flex-start'}}>
      {rounds.map((r,ri)=>(
        <div key={r.name} style={{display:'flex',flexDirection:'column',gap: ri===0?12:(ri===1?52:136),minWidth:300}}>
          <div style={{font:`700 14px 'JetBrains Mono'`,color:C.ball,letterSpacing:'0.2em',marginBottom:6}}>ROUND · {r.name}</div>
          {r.matches.map((m,i)=>(
            <SpecMatch key={i} m={m}/>
          ))}
        </div>
      ))}
    </div>
  );
}

function SpecMatch({m}) {
  const [a,sa,b,sb,scA,scB,win,status,detail] = m;
  const live = status==='live';
  const pending = status==='pending'||status==='scheduled'||status==='next';
  return (
    <div style={{
      background:C.ink800, border:`1px solid ${live?'rgba(0,226,154,0.4)':C.ink600}`,
      borderRadius:12, padding:'12px 14px',
      boxShadow:live?'0 0 24px rgba(0,226,154,0.1)':'none',
      minWidth:280,
    }}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:8,minHeight:14}}>
        {live ? (
          <>
            <span style={{display:'inline-flex',gap:6,alignItems:'center',font:"600 10px 'JetBrains Mono'",color:C.serve,letterSpacing:'0.14em'}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:C.serve,boxShadow:`0 0 8px ${C.serve}`}}/>LIVE
            </span>
            <span style={{font:"500 10px 'JetBrains Mono'",color:C.fg3,letterSpacing:'0.1em'}}>{detail}</span>
          </>
        ) : (
          <span style={{font:"500 10px 'JetBrains Mono'",color:C.fg3,letterSpacing:'0.14em',textTransform:'uppercase'}}>
            {status==='done'?'FINAL':status==='next'?'UP NEXT':'—'}
          </span>
        )}
      </div>
      <SpecRow n={a} seed={sa} s={scA} win={win==='a'} pending={pending}/>
      <div style={{height:1,background:C.ink600,margin:'7px 0'}}/>
      <SpecRow n={b} seed={sb} s={scB} win={win==='b'} pending={pending}/>
    </div>
  );
}

function SpecRow({n,seed,s,win,pending}) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:10}}>
      <div style={{font:`600 11px 'JetBrains Mono'`,color:C.fg3,minWidth:24}}>{seed?`[${seed}]`:''}</div>
      <div style={{flex:1,font:`600 15px 'Space Grotesk'`,color:win?C.serve:(pending?C.fg3:C.fg1)}}>{n||'—'}</div>
      <div style={{font:`700 22px 'JetBrains Mono'`,fontVariantNumeric:'tabular-nums',color:win?C.serve:(pending?C.fg3:C.fg2),lineHeight:1,minWidth:24,textAlign:'right'}}>{pending||s==null?'':s}</div>
    </div>
  );
}

Object.assign(window, { SpecHeader, Bracket });


// ---- App mount (moved from index.html) ----
ReactDOM.createRoot(document.getElementById('root')).render(<div><SpecHeader/><Bracket/></div>);
