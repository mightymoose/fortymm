/* FortyMM match primitives (v2.1) — shared by the gallery, previews and app screens.
   FMMatch.row(m)      match row: status, names, games won (boxed), current points (large), game-score disclosure
   FMMatch.games(m)    game history table
   FMMatch.slot(m)     schedule block (button; full names in tooltip + accessible name)
   FMMatch.timeline()  schedule timeline from FMMatch.day
   FMMatch.detail(m)   match detail card with state-appropriate actions
   Markup uses kit.css classes only, so it can also be written by hand. */
(function(){
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const min=t=>{const [h,m]=t.split(':').map(Number);return h*60+m};
const fmt=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
const ic=n=>'<span data-icon="'+n+'"></span>';
function st(m){const g=m.games||[];const inPlay=(m.state==='live'||m.state==='offline')&&g.length;const done=inPlay?g.slice(0,-1):g;const cur=inPlay?g[g.length-1]:null;const won=[0,1].map(i=>done.filter(x=>x[i]>x[1-i]).length);return{done,cur,won,winner:m.state==='final'?(won[0]>won[1]?0:1):-1}}
const short=p=>p.short||p.name.split(',')[0];
const vs=m=>esc(m.p[0].name)+' vs '+esc(m.p[1].name);

function status(m){switch(m.state){
case 'live':return '<span class="live-marker">Live</span>';
case 'final':return '<span class="fm-status">Final</span>';
case 'offline':return '<span class="fm-status fm-status--offline">Scorer offline</span>';
case 'conflict':return '<span class="fm-status fm-status--conflict">'+ic('alert')+'Needs decision</span>';
default:if(m.called)return '<span class="fm-status">'+ic('check')+'Called</span>';return '<span class="fm-status">'+ic('clock')+'<span class="num">'+m.start+'</span></span>'}}

function games(m){const s=st(m);const all=s.cur?s.done.concat([s.cur]):s.done;if(!all.length)return '<p class="fm-help">No games played yet.</p>';
let h='<table class="fm-games"><caption class="fm-sr">Game scores, '+vs(m)+'</caption><thead><tr><th scope="col"><span class="fm-sr">Player</span></th>';
all.forEach((g,i)=>{const c=s.cur&&i===all.length-1;h+='<th scope="col"'+(c?' class="cur"':'')+'>'+(c?'Game '+(i+1)+' · now':'Game '+(i+1))+'</th>'});h+='</tr></thead><tbody>';
[0,1].forEach(p=>{h+='<tr><th scope="row">'+esc(short(m.p[p]))+'</th>';all.forEach((g,i)=>{const c=s.cur&&i===all.length-1;h+='<td class="'+(c?'cur':(g[p]>g[1-p]?'w':''))+'">'+g[p]+'</td>'});h+='</tr>'});
return h+'</tbody></table>'}

function row(m,o){o=o||{};const s=st(m);const scored=m.state==='live'||m.state==='offline';const id=(o.idPrefix||'m')+'-'+m.id;
const meta=[m.state!=='upcoming'&&m.state!=='conflict'?'Table '+m.table:'Table '+m.table,m.round,m.state==='live'&&s.cur?'Game '+(s.done.length+1):null,m.state==='offline'?'last update <span class="num">'+m.offlineSince+'</span>':null].filter(Boolean).join(' · ');
let h='<article class="fm-match'+(o.lg?' fm-match--lg':'')+'" data-state="'+m.state+'" aria-label="'+vs(m)+'"><div class="fm-match__head">'+status(m)+'<span>'+meta+'</span></div>';
if(o.cols!==false&&(scored||m.state==='final'))h+='<div class="fm-match__p fm-match__cols" aria-hidden="true"><span></span><span></span><span>Games</span>'+(scored?'<span>Points</span>':'')+'</div>';
[0,1].forEach(i=>{const p=m.p[i];const cls=s.winner===-1?'':(s.winner===i?'w':'l');
h+='<div class="fm-match__p '+cls+'"><span class="fm-match__name">'+esc(p.name)+(o.club&&p.club?'<small>'+esc(p.club)+'</small>':'')+'</span>';
if(scored||m.state==='final'){h+='<span>'+(scored&&m.serve===i?'<span class="serve-marker" role="img" aria-label="Serving"></span>':'')+'</span><span class="fm-match__games" aria-label="'+s.won[i]+' games won">'+s.won[i]+'</span>';if(scored)h+='<span class="fm-match__pts" aria-label="'+(s.cur?s.cur[i]:0)+' points in this game">'+(s.cur?s.cur[i]:0)+'</span>'}
h+='</div>'});
if(m.rest)h+='<p class="fm-notice fm-notice--rest">'+ic('clock')+'<span>'+esc(m.rest.who)+' rests until <span class="num">'+m.rest.until+'</span></span></p>';
if((m.games||[]).length&&o.details!==false)h+='<button class="fm-match__toggle" data-disclosure aria-expanded="false" aria-controls="'+id+'-g">Game scores'+ic('chevron')+'</button><div id="'+id+'-g" hidden>'+games(m)+'</div>';
return h+'</article>'}

function slot(m,o){o=o||{};const t0=o.t0||min('10:30');const left=(min(m.start)-t0),w=(min(m.end)-min(m.start));const pos=o.abs!==false?' style="left:calc('+left+' * var(--ppm));width:calc('+w+' * var(--ppm) - 6px)"':'';
if(m.state==='free')return '<div class="fm-slot" data-state="free"'+pos+'><span class="fm-slot__status">Free</span><span class="fm-slot__time">'+m.start+'–'+m.end+'</span></div>';
const s=st(m);let top='';
if(m.state==='live')top='<span class="fm-slot__status live-marker">Live</span>';
else if(m.state==='final')top='<span class="fm-slot__status">Final <span class="num">'+s.won[0]+'–'+s.won[1]+'</span></span>';
else if(m.state==='offline')top='<span class="fm-slot__status">Scorer offline</span>';
else if(m.state==='conflict')top='<span class="fm-slot__status">Needs decision</span>';
else if(m.rest)top='<span class="fm-slot__status rest">'+esc(m.rest.who)+' rests to <span class="num">'+m.rest.until+'</span></span>';
const time=m.state==='live'||m.state==='offline'?'since '+m.start:m.start+'–'+m.end;
const tipText=m.p[0].name+' vs '+m.p[1].name+' · Table '+m.table+' · '+time+(m.state==='conflict'&&m.conflict?' · '+m.conflict.short:'');
return '<button class="fm-slot" data-state="'+m.state+'" data-id="'+m.id+'" aria-pressed="false" data-tip="'+esc(tipText)+'" data-label="'+esc(short(m.p[0])+' vs '+short(m.p[1]))+'"'+pos+'>'+top+'<span class="fm-slot__names"><span>'+esc(short(m.p[0]))+'</span><span>'+esc(short(m.p[1]))+'</span></span><span class="fm-slot__time">'+time+'</span><span class="fm-sr">'+esc(tipText)+'</span></button>'}

function timeline(o){o=o||{};const d=FMMatch.day,t0=min(d.from),t1=min(d.to);let h='<div class="fm-timeline" data-select="single" data-announce="on" aria-label="Schedule, '+d.from+' to '+d.to+'"><span aria-hidden="true"></span><div class="fm-timeline__ruler" aria-hidden="true" style="width:calc('+(t1-t0)+' * var(--ppm))">';
for(let t=t0;t<t1;t+=30)h+='<span style="left:calc('+(t-t0)+' * var(--ppm))">'+fmt(t)+'</span>';
if(d.now)h+='<span class="now" style="left:calc('+(min(d.now)-t0)+' * var(--ppm))">Now '+d.now+'</span>';h+='</div>';
d.tables.forEach(tb=>{h+='<div class="fm-timeline__table">Table '+tb+'</div><div class="fm-timeline__track" role="group" aria-label="Table '+tb+'" style="width:calc('+(t1-t0)+' * var(--ppm))">';d.matches.filter(m=>m.table===tb).forEach(m=>h+=slot(m,{t0}));if(d.now)h+='<span class="fm-timeline__now" style="left:calc('+(min(d.now)-t0)+' * var(--ppm))"></span>';h+='</div>'});
return h+'</div>'}

function detail(m){const s=st(m);let alert='',acts='';
if(m.state==='conflict'&&m.conflict)alert='<div class="fm-alert fm-alert--warning" role="group" aria-label="Scheduling conflict">'+ic('alert')+'<p class="fm-alert__title">'+esc(m.conflict.title)+'</p><p class="fm-alert__body">'+esc(m.conflict.body)+'</p><div class="fm-alert__actions"><button class="fm-btn fm-btn--primary fm-btn--sm" data-act="fix">'+esc(m.conflict.fix)+'</button><button class="fm-btn fm-btn--secondary fm-btn--sm" data-act="keep">Keep '+m.start+'</button></div></div>';
if(m.state==='offline')alert='<div class="fm-alert fm-alert--error" role="alert">'+ic('offline')+'<p class="fm-alert__title">Table '+m.table+' scorer is offline</p><p class="fm-alert__body">Last score arrived at <span class="num">'+m.offlineSince+'</span>. Points entered on that device will sync when it reconnects.</p><div class="fm-alert__actions"><button class="fm-btn fm-btn--primary fm-btn--sm" data-act="takeover">Score from this device</button><button class="fm-btn fm-btn--secondary fm-btn--sm" data-act="ping">Send a reminder</button></div></div>';
if(m.kept)alert='<p class="fm-notice fm-notice--warning">'+ic('alert')+'<span>'+esc(m.conflict.kept)+'</span></p>';
if(m.state==='live')acts='<a class="fm-btn fm-btn--secondary" href="../tournament/mobile.html">Open scoring</a><button class="fm-btn fm-btn--ghost" data-demo>Move to another table</button>';
if(m.state==='upcoming')acts=(m.called?'<button class="fm-btn fm-btn--secondary" data-uncall="'+m.id+'">Cancel call</button>':'<button class="fm-btn fm-btn--primary" data-act="call"'+(m.rest?' aria-disabled="true" data-tip="'+esc(m.rest.who)+' is resting until '+m.rest.until+'"':'')+'>Call to table</button>')+'<button class="fm-btn fm-btn--ghost" data-demo>Reschedule</button><button class="fm-btn fm-btn--danger end" data-dialog="dlg-withdraw">Withdraw a player…</button>';
if(m.state==='final')acts='<button class="fm-btn fm-btn--secondary" data-demo>Edit result</button><button class="fm-btn fm-btn--ghost" data-demo>Print score sheet</button>';
const facts=[['Event',m.event],['Round',m.round],['Table','Table '+m.table],[m.state==='final'?'Played':'Start',m.state==='final'?m.start+'–'+m.end:m.start]];
return '<section class="fm-card" aria-labelledby="dt-'+m.id+'"><div class="fm-card__head"><div><h3 class="fm-card__title" id="dt-'+m.id+'">'+esc(short(m.p[0]))+' vs '+esc(short(m.p[1]))+'</h3><p class="fm-card__sub">'+esc(m.event)+' · '+esc(m.round)+'</p></div>'+status(m)+'</div><div class="fm-card__body">'+row(m,{cols:true,details:false,club:true,lg:true,idPrefix:'d'}).replace('<div class="fm-match__head">','<div class="fm-match__head" hidden>')+alert+
((m.games||[]).length?'<div><h4 class="fm-section-title" style="margin-bottom:8px">Game scores</h4><div class="fm-scroll">'+games(m)+'</div></div>':'')+
'<dl class="fm-dl">'+facts.map(f=>'<div><dt>'+f[0]+'</dt><dd>'+esc(f[1])+'</dd></div>').join('')+'</dl></div>'+(acts?'<div class="fm-card__foot">'+acts+'</div>':'')+'</section>'}

const P=(name,club,s)=>({name,club,short:s});
const day={from:'10:30',to:'13:00',now:'11:47',tables:[1,2,3,4],matches:[
{id:'a1',table:1,state:'final',start:'10:30',end:'11:05',event:'Open singles',round:'Round of 32',p:[P('Nguyen, Thanh','Riverside TT'),P('Silva, Rafael','Northside')],games:[[11,7],[9,11],[11,8],[11,6]]},
{id:'a2',table:1,state:'live',start:'11:10',end:'11:45',event:'Open singles',round:'Round of 16',serve:0,p:[P('Okafor-Adeyemi, Daniel','Eastgate'),P('Johansen-Whitfield, Annika','Northside')],games:[[11,9],[8,11],[11,6],[8,6]]},
{id:'a3',table:1,state:'upcoming',start:'12:00',end:'12:35',event:'Open singles',round:'Round of 16',p:[P('Chen, Wei','Riverside TT'),P('Ali, Rashid','Eastgate')],games:[]},
{id:'b1',table:2,state:'final',start:'10:30',end:'11:00',event:'Under 18 singles',round:'Quarterfinal',p:[P('Lindqvist, Erik','Northside'),P('Haddad, Youssef','Riverside TT')],games:[[11,5],[11,8],[11,4]]},
{id:'b2',table:2,state:'free',start:'11:05',end:'11:45'},
{id:'b3',table:2,state:'conflict',start:'11:50',end:'12:25',event:'Open singles',round:'Round of 16',p:[P('Patel, Meera','Riverside TT'),P('Park, Ji-ho','Eastgate')],games:[],conflict:{short:'Patel would rest 5 min',title:'Patel would get 5 minutes’ rest',body:'Her match on Table 3 is running 10 minutes over. Starting at 12:05 keeps the 15-minute minimum.',fix:'Move to 12:05',kept:'Kept at 11:50 by the organizer. Patel gets 5 minutes’ rest, under the 15-minute minimum.'}},
{id:'c1',table:3,state:'final',start:'10:30',end:'11:05',event:'Open singles',round:'Round of 32',p:[P('Moreau, Élodie','Eastgate'),P('Kim, Hyun-woo','Northside')],games:[[11,9],[7,11],[11,13],[11,8],[12,10]]},
{id:'c2',table:3,state:'live',start:'11:05',end:'11:45',event:'Open singles',round:'Round of 32',serve:1,p:[P('Patel, Meera','Riverside TT'),P('Wójcik-Szymańska, Agnieszka','Northside')],games:[[11,8],[6,11],[11,9],[9,11],[9,9]]},
{id:'c3',table:3,state:'upcoming',start:'12:15',end:'12:50',event:'Under 18 singles',round:'Semifinal',p:[P('Dubois, Camille','Eastgate'),P('Lindqvist, Erik','Northside')],games:[],rest:{who:'Lindqvist',until:'12:10'}},
{id:'d1',table:4,state:'offline',start:'11:00',end:'11:40',event:'Open doubles',round:'Quarterfinal',serve:1,offlineSince:'11:42',p:[P('Rossi, Giulia / Haddad, Youssef','Riverside TT','Rossi / Haddad'),P('Fernández-Castillo, Marisol / Kim, Hyun-woo','Northside','Fernández-Castillo / Kim')],games:[[11,7],[5,11],[4,7]]},
{id:'d2',table:4,state:'upcoming',start:'12:05',end:'12:40',event:'Open singles',round:'Round of 16',p:[P('Moreau, Élodie','Eastgate'),P('Silva, Rafael','Northside')],games:[]}
]};
window.FMMatch={row,games,slot,timeline,detail,status,day,find:id=>day.matches.find(m=>m.id===id)};
})();
