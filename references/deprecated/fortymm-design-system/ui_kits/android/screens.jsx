// Android screens for FortyMM — same visual language as iOS kit but with Material-ish adjustments
const C = {
  ink950:'#0B0D12', ink900:'#11141B', ink800:'#171B24', ink700:'#1F2430',
  ink600:'#2A3040', ink500:'#3A4152',
  fg1:'#F7F8FB', fg2:'#E4E7EF', fg3:'#A9B0C2',
  ball:'#FF7A1A', serve:'#00E29A',
};

function AScreen({children}) {
  return <div style={{height:'100%',background:C.ink950,color:C.fg1,fontFamily:"'Roboto', 'Space Grotesk', sans-serif",overflowY:'auto',paddingBottom:80}}>{children}</div>;
}

function ATopBar({title}) {
  return (
    <div style={{height:56,display:'flex',alignItems:'center',padding:'0 16px',gap:16,borderBottom:`1px solid ${C.ink600}`}}>
      <div style={{fontFamily:"'Bebas Neue', sans-serif", fontSize:26, letterSpacing:'0.03em', color:C.fg1}}>{title}</div>
      <div style={{flex:1}}/>
      <div style={{width:24,height:24,borderRadius:'50%',background:C.ink700}}/>
    </div>
  );
}

function ABottomNav({active='home'}) {
  const items = [{k:'home',l:'Matches'},{k:'find',l:'Find'},{k:'bracket',l:'Draws'},{k:'you',l:'You'}];
  return (
    <div style={{position:'absolute',bottom:0,left:0,right:0,height:72,background:C.ink900,borderTop:`1px solid ${C.ink600}`,display:'flex',paddingBottom:8}}>
      {items.map(i=>(
        <div key={i.k} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:4}}>
          <div style={{width:active===i.k?64:24, height:32, borderRadius:16, background:active===i.k?'rgba(255,122,26,0.18)':'transparent',display:'flex',alignItems:'center',justifyContent:'center'}}>
            <div style={{width:20,height:20,borderRadius:active===i.k?'50%':4, background:active===i.k?C.ball:C.ink600}}/>
          </div>
          <div style={{font:`600 10px 'Roboto'`, letterSpacing:'0.1em', color:active===i.k?C.ball:C.fg3, textTransform:'uppercase'}}>{i.l}</div>
        </div>
      ))}
    </div>
  );
}

function AFab() {
  return (
    <div style={{position:'absolute',right:20,bottom:92,width:56,height:56,borderRadius:16,background:C.ball,color:C.ink950,display:'flex',alignItems:'center',justifyContent:'center',fontSize:28,fontWeight:700,boxShadow:'0 8px 24px rgba(255,122,26,0.45)'}}>+</div>
  );
}

function AHome() {
  return (
    <AScreen>
      <ATopBar title="FORTYMM"/>
      <div style={{padding:'16px'}}>
        <div style={{font:'600 11px monospace', letterSpacing:'0.14em', color:C.fg3, textTransform:'uppercase', marginBottom:10}}>● Live near you</div>
        <div style={{background:C.ink800, border:'1px solid rgba(0,226,154,0.3)', borderRadius:12, padding:14, boxShadow:'0 0 20px rgba(0,226,154,0.08)'}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:10}}>
            <span style={{display:'inline-flex',gap:6,alignItems:'center',font:`600 10px monospace`,letterSpacing:'0.14em',color:C.serve}}>
              <span style={{width:7,height:7,borderRadius:'50%',background:C.serve,boxShadow:`0 0 8px ${C.serve}`}}/>LIVE · GAME 3
            </span>
            <span style={{font:`500 10px monospace`, color:C.fg3, letterSpacing:'0.1em'}}>COURT 3</span>
          </div>
          <APlayerRow n="Nguyen, T." s={11} seed="1" win/>
          <div style={{height:1,background:C.ink600,margin:'10px 0'}}/>
          <APlayerRow n="Okafor, D." s={8} seed="8"/>
        </div>

        <div style={{font:'600 11px monospace', letterSpacing:'0.14em', color:C.fg3, textTransform:'uppercase', margin:'24px 0 10px'}}>Upcoming</div>
        {['Tran, L. · Today 20:30','Silva, R. · Tomorrow 19:00','Kim, H. · Sat 14:00'].map(t=>(
          <div key={t} style={{background:C.ink800,border:`1px solid ${C.ink600}`,borderRadius:10,padding:'12px 14px',marginBottom:8, display:'flex',alignItems:'center',gap:12}}>
            <div style={{width:36,height:36,borderRadius:'50%',background:C.ink700,display:'flex',alignItems:'center',justifyContent:'center',font:'700 12px sans-serif',color:C.fg2}}>
              {t.slice(0,2).toUpperCase()}
            </div>
            <div style={{flex:1,font:'500 14px sans-serif',color:C.fg1}}>{t}</div>
            <div style={{font:'700 12px monospace',color:C.ball,background:'rgba(255,122,26,0.14)',padding:'4px 10px',borderRadius:999}}>★ 1980</div>
          </div>
        ))}
      </div>
      <AFab/>
      <ABottomNav active="home"/>
    </AScreen>
  );
}

function APlayerRow({n,s,seed,win}) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:12}}>
      <div style={{width:36,height:36,borderRadius:'50%',background:win?'linear-gradient(135deg,#FF7A1A,#B94700)':C.ink700,boxShadow:win?`0 0 0 2px ${C.ball}`:'none',display:'flex',alignItems:'center',justifyContent:'center',font:'700 13px sans-serif',color:win?'#fff':C.fg2}}>{n.slice(0,2).toUpperCase()}</div>
      <div style={{flex:1}}>
        <div style={{font:'600 15px sans-serif',color:win?C.serve:C.fg1}}>{n}</div>
        <div style={{font:`500 10px monospace`,color:C.fg3,letterSpacing:'0.1em'}}>SEED {seed}</div>
      </div>
      <div style={{font:`700 30px monospace`,fontVariantNumeric:'tabular-nums',color:win?C.serve:C.fg1}}>{s}</div>
    </div>
  );
}

Object.assign(window, { AHome, APlayerRow });


// ---- App mount (moved from index.html) ----
function Phone({children}) {
    return (
      <div style={{width:380,height:790,borderRadius:36,overflow:'hidden',border:'8px solid #2A3040',background:'#0B0D12',position:'relative',boxShadow:'0 40px 80px rgba(0,0,0,0.55)'}}>
        <div style={{height:32,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 18px',color:'#fff',fontSize:13,fontFamily:'Roboto'}}>
          <span>9:30</span>
          <div style={{width:10,height:10,borderRadius:'50%',background:'#2e2e2e'}}/>
          <div style={{display:'flex',gap:5}}><div style={{width:14,height:10,background:'#fff',clipPath:'polygon(0 100%, 100% 100%, 100% 0)'}}/><div style={{width:18,height:10,border:'1px solid #fff',borderRadius:2}}/></div>
        </div>
        {children}
      </div>
    );
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<Phone><AHome/></Phone>);
