/* FortyMM shared behaviours (v2.1). Used by the gallery, previews and app screens.
   Icons · tooltips (hover + focus, Esc) · single-select groups (radiogroup/tablist/pressed) ·
   filter chips with exclusive "All" · switches · disclosures · toasts · dialogs · split handle ·
   score entry · polite live announcements. No dependencies. */
(function(){
const P={
check:'<path d="M20 6 9 17l-5-5"/>',
alert:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
error:'<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
chevron:'<path d="m6 9 6 6 6-6"/>',
more:'<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
undo:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
offline:'<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
minus:'<path d="M5 12h14"/>',
map:'<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
table:'<rect x="3" y="5" width="18" height="12" rx="1"/><path d="M12 5v12"/><path d="M8 21l1-4"/><path d="M16 21l-1-4"/>',
user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
calendar:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
left:'<path d="m15 18-6-6 6-6"/>',right:'<path d="m9 18 6-6-6-6"/>',
list:'<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'
};
const FM=window.FM=window.FM||{};
/* Test mode: ?test in the URL or <html data-test>. Turns off transitions/animation and the caret,
   shows tooltips instantly, keeps toasts until dismissed. ?only=<testid> renders just that example.
   <html data-fm-ready="true"> is set once fonts are loaded and every component is initialised. */
const QS=new URLSearchParams(location.search);
const T=FM.test={on:QS.has('test')||document.documentElement.hasAttribute('data-test')};
if(T.on)document.documentElement.classList.add('fm-test');
let uidN=0;const nextId=p=>p+(++uidN);
const escH=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const normH=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const svg=n=>'<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'+(P[n]||'')+'</svg>';
FM.iconSvg=n=>'<span class="fm-ic fm-ic--sm" aria-hidden="true">'+svg(n)+'</span>';
FM.icons=function(root){(root||document).querySelectorAll('[data-icon]').forEach(e=>{if(e.querySelector('svg'))return;e.classList.add('fm-ic');e.setAttribute('aria-hidden','true');e.innerHTML=svg(e.dataset.icon)})};

let live;
FM.announce=function(msg){if(!live){live=document.createElement('div');live.className='fm-sr';live.setAttribute('aria-live','polite');document.body.appendChild(live)}live.textContent='';setTimeout(()=>{live.textContent=msg},40)};

/* Tooltip */
let tip,tipT,owner;
function tipEl(){if(!tip){tip=document.createElement('div');tip.className='fm-tooltip';tip.id='fm-tooltip';tip.setAttribute('role','tooltip');tip.hidden=true;document.body.appendChild(tip)}return tip}
function showTip(el){const t=tipEl();t.textContent=el.dataset.tip;t.hidden=false;owner=el;el.setAttribute('aria-describedby','fm-tooltip');const r=el.getBoundingClientRect(),w=t.offsetWidth,h=t.offsetHeight;let top=r.top-h-8;if(top<8)top=r.bottom+8;let left=Math.max(8,Math.min(r.left+r.width/2-w/2,innerWidth-w-8));t.style.top=(top+scrollY)+'px';t.style.left=(left+scrollX)+'px'}
function hideTip(){clearTimeout(tipT);if(tip)tip.hidden=true;if(owner){owner.removeAttribute('aria-describedby');owner=null}}
document.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const el=e.target.closest('[data-tip]');if(!el||el===owner)return;clearTimeout(tipT);tipT=setTimeout(()=>showTip(el),T.on?0:300)});
document.addEventListener('pointerout',e=>{const el=e.target.closest('[data-tip]');if(el&&!el.contains(e.relatedTarget)){clearTimeout(tipT);if(document.activeElement!==el)hideTip()}});
document.addEventListener('focusin',e=>{const el=e.target.closest('[data-tip]');if(el&&el.matches(':focus-visible'))showTip(el)});
document.addEventListener('focusout',e=>{if(e.target.closest('[data-tip]'))hideTip()});
addEventListener('scroll',hideTip,true);

/* Blocks clicks on aria-disabled controls (they stay focusable so their reason can be read) */
document.addEventListener('click',e=>{const d=e.target.closest('[aria-disabled=true]');if(d){e.preventDefault();e.stopImmediatePropagation()}},true);

/* Selection groups */
function attr(g){const r=g.getAttribute('role');return r==='radiogroup'?'aria-checked':r==='tablist'?'aria-selected':'aria-pressed'}
function items(g){return [...g.querySelectorAll('button')].filter(b=>b.closest('[data-select]')===g&&!b.disabled)}
FM.select=function(g,b,focus){const a=attr(g),rove=a!=='aria-pressed';items(g).forEach(x=>{const on=x===b;x.setAttribute(a,String(on));if(rove)x.tabIndex=on?0:-1;const p=x.getAttribute('aria-controls');if(a==='aria-selected'&&p){const el=document.getElementById(p);if(el)el.hidden=!on}});if(focus)b.focus();if(a==='aria-pressed'&&g.dataset.announce!=='off')FM.announce((b.dataset.label||b.textContent.trim())+', selected');g.dispatchEvent(new CustomEvent('fm-change',{bubbles:true,detail:{value:b.dataset.value||b.textContent.trim(),button:b}}))};
function filter(g,b){const all=g.querySelector('[data-all]'),rest=items(g).filter(x=>x!==all);if(b===all){rest.forEach(x=>x.setAttribute('aria-pressed','false'))}else{b.setAttribute('aria-pressed',String(b.getAttribute('aria-pressed')!=='true'))}if(all)all.setAttribute('aria-pressed',String(!rest.some(x=>x.getAttribute('aria-pressed')==='true')));const on=items(g).filter(x=>x.getAttribute('aria-pressed')==='true').map(x=>x.textContent.trim());FM.announce('Showing '+on.join(', '));g.dispatchEvent(new CustomEvent('fm-change',{bubbles:true,detail:{values:on}}))}
document.addEventListener('click',e=>{
const b=e.target.closest('button');if(!b||b.disabled)return;
const g=b.closest('[data-select]');
if(g&&items(g).includes(b)){g.dataset.select==='filter'?filter(g,b):FM.select(g,b)}
if(b.getAttribute('role')==='switch'){const on=b.getAttribute('aria-checked')!=='true';b.setAttribute('aria-checked',String(on));b.dispatchEvent(new CustomEvent('fm-change',{bubbles:true,detail:{value:on}}))}
if(b.hasAttribute('data-disclosure')){const t=document.getElementById(b.getAttribute('aria-controls'));const open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));if(t)t.hidden=!open}
if(b.dataset.dialog){const d=document.getElementById(b.dataset.dialog);if(d)d.showModal()}
if(b.hasAttribute('data-close')){const d=b.closest('dialog');if(d)d.close(b.value||'')}
if(b.dataset.toast){FM.toast(b.dataset.toast,{undo:reversible(b)})}
if(b.dataset.demo!==undefined){FM.toast('“'+(b.dataset.demo||b.textContent.trim())+'” isn’t wired up in this demo',{icon:'info'})}
if(b.dataset.busy){if(b.getAttribute('aria-busy')==='true')return;const label=b.textContent;b.setAttribute('aria-busy','true');b.textContent=b.dataset.busy;setTimeout(()=>{b.removeAttribute('aria-busy');b.textContent=label;if(b.dataset.done)FM.toast(b.dataset.done)},1400)}
});
document.addEventListener('keydown',e=>{
if(e.key==='Escape'&&owner){hideTip();return}
const b=e.target.closest('button');if(!b)return;const g=b.closest('[data-select]');if(!g||attr(g)==='aria-pressed')return;
const list=items(g),i=list.indexOf(b);if(i<0)return;let n=null;
if(e.key==='ArrowRight'||e.key==='ArrowDown')n=list[(i+1)%list.length];
if(e.key==='ArrowLeft'||e.key==='ArrowUp')n=list[(i-1+list.length)%list.length];
if(e.key==='Home')n=list[0];if(e.key==='End')n=list[list.length-1];
if(n){e.preventDefault();FM.select(g,n,true)}
});
document.addEventListener('click',e=>{if(e.target.tagName==='DIALOG'){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close()}});

/* Declarative reversible effects for data-toast buttons. Undo is offered only when something on the page
   actually changed: data-done-label (trigger relabels + aria-disabled), data-hide="id", data-reveal="id". */
function reversible(b){if(!b.hasAttribute('data-undo'))return null;const fx=[];
if(b.dataset.doneLabel){const old=b.innerHTML;b.textContent=b.dataset.doneLabel;b.setAttribute('aria-disabled','true');fx.push(()=>{b.innerHTML=old;b.removeAttribute('aria-disabled')})}
if(b.dataset.hide){const t=document.getElementById(b.dataset.hide);if(t){t.hidden=true;fx.push(()=>{t.hidden=false})}}
if(b.dataset.reveal){const t=document.getElementById(b.dataset.reveal);if(t){t.hidden=false;fx.push(()=>{t.hidden=true})}}
if(!fx.length){console.warn('FM: data-undo without a reversible effect — Undo not offered',b);return null}
return()=>{fx.forEach(f=>f());if(b.isConnected)b.focus()}}

/* Toast: success/confirmation only. 6 s; pauses on hover/focus. Errors use .fm-alert instead. */
FM.toast=function(msg,opt){opt=opt||{};let r=document.querySelector('.fm-toast-region');if(!r){r=document.createElement('div');r.className='fm-toast-region';r.setAttribute('role','status');r.setAttribute('aria-live','polite');document.body.appendChild(r)}
const t=document.createElement('div');t.className='fm-toast'+(opt.icon&&opt.icon!=='check'?' fm-toast--info':'');t.innerHTML='<span data-icon="'+(opt.icon||'check')+'"></span><span class="fm-toast__msg"></span>';t.querySelector('.fm-toast__msg').textContent=msg;
let timer;const close=()=>{clearTimeout(timer);t.remove()};const arm=()=>{clearTimeout(timer);if(T.on&&!opt.duration)return;timer=setTimeout(close,opt.duration||6000)};
if(opt.undo){const u=document.createElement('button');u.className='fm-btn fm-btn--sm fm-toast__action';u.textContent='Undo';u.onclick=()=>{opt.undo();close();FM.announce('Undone')};t.appendChild(u)}
const x=document.createElement('button');x.className='fm-btn fm-btn--sm fm-toast__close';x.setAttribute('aria-label','Dismiss');x.innerHTML=FM.iconSvg('x');x.onclick=close;t.appendChild(x);
t.addEventListener('mouseenter',()=>clearTimeout(timer));t.addEventListener('mouseleave',arm);t.addEventListener('focusin',()=>clearTimeout(timer));t.addEventListener('focusout',arm);
while(r.children.length>=3)r.firstChild.remove();r.appendChild(t);FM.icons(t);arm();return close};

/* Split handle: drag or arrow keys */
FM.split=function(root){(root||document).querySelectorAll('.fm-split__handle').forEach(h=>{if(h._fm)return;h._fm=1;const s=h.closest('.fm-split');const set=p=>{p=Math.max(35,Math.min(72,p));s.style.setProperty('--split',p+'%');h.setAttribute('aria-valuenow',Math.round(p))};
h.addEventListener('keydown',e=>{const v=+h.getAttribute('aria-valuenow')||58;const k={ArrowLeft:v-4,ArrowRight:v+4,Home:35,End:72}[e.key];if(k!==undefined){e.preventDefault();set(k)}});
h.addEventListener('pointerdown',e=>{h.setPointerCapture(e.pointerId);const r=s.getBoundingClientRect();const mv=ev=>set((ev.clientX-r.left)/r.width*100);const up=()=>{h.removeEventListener('pointermove',mv);h.removeEventListener('pointerup',up)};h.addEventListener('pointermove',mv);h.addEventListener('pointerup',up)})})};

/* Score entry: data-scorepad='{"names":[..],"games":[[11,7],[9,11]],"pts":[4,3],"serve":0,"bestOf":5}' */
FM.scorepad=function(el){const cfg=JSON.parse(el.dataset.scorepad);const st={pts:cfg.pts.slice(),done:cfg.games.slice(),serve:cfg.serve||0};const hist=[];
const won=i=>st.done.filter(g=>g[i]>g[1-i]).length;const need=Math.ceil((cfg.bestOf||5)/2);
function render(changed){[0,1].forEach(i=>{const p=el.querySelector('[data-pts="'+i+'"]');p.textContent=st.pts[i];el.querySelector('[data-games="'+i+'"]').textContent=won(i);el.querySelector('[data-serve="'+i+'"]').style.visibility=st.serve===i?'visible':'hidden';el.querySelector('[data-add="'+i+'"]').disabled=won(0)>=need||won(1)>=need;if(changed===i){p.classList.remove('score-updated');void p.offsetWidth;p.classList.add('score-updated')}});
const u=el.querySelector('[data-undo]');u.disabled=!hist.length;const h=el.querySelector('[data-history]');if(h&&window.FMMatch)h.innerHTML=FMMatch.games({p:cfg.names.map(n=>({name:n,short:n.split(',')[0]})),games:st.done.concat(won(0)>=need||won(1)>=need?[]:[st.pts.slice()]),state:'live',id:el.id||'sp'})}
el.addEventListener('click',e=>{const a=e.target.closest('[data-add]');const u=e.target.closest('[data-undo]');
if(a){const i=+a.dataset.add;hist.push(JSON.stringify(st));st.pts[i]++;const tot=st.pts[0]+st.pts[1];const deuce=st.pts[0]>=10&&st.pts[1]>=10;if(deuce||tot%2===0)st.serve=1-st.serve;
const [x,y]=st.pts;if((x>=11||y>=11)&&Math.abs(x-y)>=2){st.done.push([x,y]);const w=x>y?0:1;st.pts=[0,0];render(i);const short=cfg.names[w].split(',')[0];FM.toast('Game '+st.done.length+' to '+short+', '+Math.max(x,y)+'–'+Math.min(x,y),{undo:()=>{Object.assign(st,JSON.parse(hist.pop()));render()}});return}
render(i);FM.announce(cfg.names[i].split(',')[0]+' '+st.pts[i]+', '+cfg.names[1-i].split(',')[0]+' '+st.pts[1-i])}
if(u&&hist.length){Object.assign(st,JSON.parse(hist.pop()));render();FM.announce('Last point undone')}});
render()};

/* Date picker. <div class="fm-datefield" data-datepicker='{"value":"2026-04-11","today":"2026-04-10","min":"2026-04-01"}'> with an input + button,
   or <div class="fm-cal fm-cal--inline" data-datepicker='…'>. Arrows move a day/week, PageUp/PageDown a month, Enter picks, Esc closes. */
const MON=['January','February','March','April','May','June','July','August','September','October','November','December'],DOW=['Mo','Tu','We','Th','Fr','Sa','Su'],DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const parse=s=>{const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d)};
const long=d=>DAYS[d.getDay()]+' '+d.getDate()+' '+MON[d.getMonth()]+' '+d.getFullYear();
/* Accepts "11 April 2026", "Sat 11 Apr", "April 11 2026", "11/4/2026" (day first), "11.4.26", "2026-04-11". Year optional. Returns null if not a real date. */
FM.parseDate=function(s,fallbackYear){s=s.toLowerCase().replace(/,/g,' ').replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g,' ').replace(/(\d)(st|nd|rd|th)\b/g,'$1').trim();let y,m,d,r;
if((r=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))){y=+r[1];m=+r[2];d=+r[3]}
else if((r=s.match(/^(\d{1,2})[\/.\-\s](\d{1,2})(?:[\/.\-\s](\d{2,4}))?$/))){d=+r[1];m=+r[2];y=r[3]?+r[3]:fallbackYear}
else{const mi=MON.findIndex(n=>new RegExp('\\b'+n.slice(0,3).toLowerCase()+'[a-z]*\\b').test(s));if(mi<0)return null;m=mi+1;const nums=(s.match(/\d+/g)||[]).map(Number);if(!nums.length)return null;d=nums.find(n=>n<=31);y=nums.find(n=>n>31)||(nums.length>1&&nums[1]<100&&nums[0]!==nums[1]?nums[1]:fallbackYear);if(d===undefined)return null}
if(y<100)y+=2000;const dt=new Date(y,m-1,d);return dt.getFullYear()===y&&dt.getMonth()===m-1&&dt.getDate()===d?dt:null};
FM.datepicker=function(el){const cfg=JSON.parse(el.dataset.datepicker);const inline=el.classList.contains('fm-cal');let sel=cfg.value?parse(cfg.value):null,focus=sel||parse(cfg.today),view=new Date(focus.getFullYear(),focus.getMonth(),1);const min=cfg.min?parse(cfg.min):null;
const cal=inline?el:document.createElement('div');if(!inline){cal.className='fm-overlay fm-cal';cal.hidden=true;cal.setAttribute('role','dialog');cal.setAttribute('aria-label','Choose date');el.appendChild(cal)}
const input=el.querySelector('input'),btn=el.querySelector('[data-cal-open]');const uid=nextId('cal');
function draw(moveFocus){const y=view.getFullYear(),m=view.getMonth();const start=new Date(y,m,1-((new Date(y,m,1).getDay()+6)%7));
let h='<div class="fm-cal__head"><button class="fm-btn fm-btn--ghost fm-btn--sm fm-btn--icon" data-nav="-1" aria-label="Previous month">'+FM.iconSvg('left')+'</button><span class="fm-cal__title" id="'+uid+'" aria-live="polite">'+MON[m]+' '+y+'</span><button class="fm-btn fm-btn--ghost fm-btn--sm fm-btn--icon" data-nav="1" aria-label="Next month">'+FM.iconSvg('right')+'</button></div><table role="grid" aria-labelledby="'+uid+'"><thead><tr>'+DOW.map(d=>'<th scope="col" abbr="'+d+'">'+d+'</th>').join('')+'</tr></thead><tbody>';
for(let w=0;w<6;w++){h+='<tr>';for(let i=0;i<7;i++){const d=new Date(start.getFullYear(),start.getMonth(),start.getDate()+w*7+i),k=iso(d);const cls=['fm-cal__day',d.getMonth()!==m?'out':'',k===cfg.today?'today':''].join(' ');const dis=min&&d<min;
h+='<td><button class="'+cls+'" data-date="'+k+'" tabindex="'+(k===iso(focus)?0:-1)+'" aria-selected="'+(sel&&k===iso(sel))+'" aria-label="'+long(d)+(k===cfg.today?', today':'')+'"'+(dis?' disabled':'')+'>'+d.getDate()+'</button></td>'}h+='</tr>'}
cal.innerHTML=h+'</tbody></table><div class="fm-cal__foot"><span></span><button class="fm-btn fm-btn--link" data-today>Today</button></div>';if(moveFocus){const f=cal.querySelector('[data-date="'+iso(focus)+'"]');if(f)f.focus()}}
function go(d){focus=d;if(d.getMonth()!==view.getMonth()||d.getFullYear()!==view.getFullYear())view=new Date(d.getFullYear(),d.getMonth(),1);draw(true)}
let pick=function(d){sel=d;focus=d;if(input){input.value=long(d);input.removeAttribute('aria-invalid')}el.dispatchEvent(new CustomEvent('fm-change',{bubbles:true,detail:{value:iso(d)}}));if(inline){draw(true);FM.announce(long(d)+' selected')}else close(true)};
function open(){cal.hidden=false;if(btn)btn.setAttribute('aria-expanded','true');draw(true)}
function close(ret){if(inline)return;cal.hidden=true;if(btn){btn.setAttribute('aria-expanded','false');if(ret)btn.focus()}}
if(btn){btn.setAttribute('aria-haspopup','dialog');btn.setAttribute('aria-expanded','false');btn.addEventListener('click',()=>cal.hidden?open():close(true))}
if(input&&sel)input.value=long(sel);
if(input){const err=document.createElement('p');err.className='fm-error';err.id=uid+'-err';err.hidden=true;err.innerHTML='<span data-icon="error"></span><span></span>';(el.closest('.fm-field')||el.parentNode).appendChild(err);FM.icons(err);input.setAttribute('aria-describedby',((input.getAttribute('aria-describedby')||'')+' '+err.id).trim());
const fail=msg=>{input.setAttribute('aria-invalid','true');err.lastChild.textContent=msg;err.hidden=false};
const ok=()=>{input.removeAttribute('aria-invalid');err.hidden=true};
function check(){const v=input.value.trim();if(!v){sel=null;ok();draw(false);return true}const d=FM.parseDate(v,view.getFullYear());if(!d){fail('Enter a date like 11 April 2026 or 11/4/2026.');return false}if(min&&d<min){fail('Pick '+long(min)+' or later.');return false}sel=d;focus=d;view=new Date(d.getFullYear(),d.getMonth(),1);input.value=long(d);ok();draw(false);el.dispatchEvent(new CustomEvent('fm-change',{bubbles:true,detail:{value:iso(d)}}));return true}
input.addEventListener('change',check);
input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();check()}if(e.key==='ArrowDown'&&e.altKey){e.preventDefault();open()}if(e.key==='Escape'&&!cal.hidden)close(true)});
const _pick=pick;pick=d=>{ok();_pick(d)}}
cal.addEventListener('click',e=>{const n=e.target.closest('[data-nav]'),d=e.target.closest('[data-date]'),t=e.target.closest('[data-today]');
if(n){view=new Date(view.getFullYear(),view.getMonth()+ +n.dataset.nav,1);focus=new Date(view);draw(false)}
if(d&&!d.disabled)pick(parse(d.dataset.date));if(t)go(parse(cfg.today))});
cal.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close(true);return}const d=e.target.closest('[data-date]');if(!d)return;const f=parse(d.dataset.date);const k={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[e.key];
if(k){e.preventDefault();go(new Date(f.getFullYear(),f.getMonth(),f.getDate()+k))}
else if(e.key==='PageUp'||e.key==='PageDown'){e.preventDefault();go(new Date(f.getFullYear(),f.getMonth()+(e.key==='PageUp'?-1:1),f.getDate()))}
else if(e.key==='Home'||e.key==='End'){e.preventDefault();const dow=(f.getDay()+6)%7;go(new Date(f.getFullYear(),f.getMonth(),f.getDate()+(e.key==='Home'?-dow:6-dow)))}});
if(!inline)document.addEventListener('pointerdown',e=>{if(!cal.hidden&&!el.contains(e.target))close(false)});
draw(false)};

/* Combobox (ARIA 1.2 list autocomplete). <div class="fm-combo" data-combobox='[{"name":"Nguyen, Thanh","club":"Riverside TT","rating":"2,145"},…]'><input class="fm-input" id=…></div>
   Matches name or club, ignoring accents. ↓/↑ move, Enter picks, Esc closes (again clears), Home/End stay in the text. */
FM.combobox=function(el){const data=JSON.parse(el.dataset.combobox);const input=el.querySelector('input');const uid=input.id||nextId('cb');
const norm=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const list=document.createElement('ul');list.className='fm-overlay fm-combo__list';list.id=uid+'-list';list.setAttribute('role','listbox');list.hidden=true;const lab=document.querySelector('label[for="'+input.id+'"]');if(lab)list.setAttribute('aria-label',lab.textContent.trim());el.appendChild(list);
const ic=document.createElement('span');ic.dataset.icon='search';el.insertBefore(ic,input);FM.icons(el);
input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');input.setAttribute('aria-controls',list.id);input.setAttribute('autocomplete','off');
let items=[],active=-1,chosen=null;
const hl=(name,q)=>{if(!q)return esc(name);const i=norm(name).indexOf(q);return i<0?esc(name):esc(name.slice(0,i))+'<mark>'+esc(name.slice(i,i+q.length))+'</mark>'+esc(name.slice(i+q.length))};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function render(){const q=norm(input.value.trim());items=data.filter(p=>!q||norm(p.name).includes(q)||norm(p.club||'').includes(q));
if(!items.length){list.innerHTML='<li class="fm-combo__empty" role="presentation">No players match “'+esc(input.value.trim())+'”. Check the spelling or search by club.</li>';active=-1}
else list.innerHTML=items.map((p,i)=>'<li class="fm-combo__opt" role="option" id="'+uid+'-o'+i+'" aria-selected="'+(i===active)+'"><span class="ck">'+(chosen===p?FM.iconSvg('check'):'')+'</span><b>'+hl(p.name,q)+'</b>'+(p.club?'<small>'+esc(p.club)+'</small>':'')+(p.rating?'<span class="r" aria-label="rating '+p.rating+'">'+p.rating+'</span>':'')+'</li>').join('');
if(active>=0){input.setAttribute('aria-activedescendant',uid+'-o'+active);const a=list.children[active];if(a){const t=a.offsetTop,b=t+a.offsetHeight;if(t<list.scrollTop)list.scrollTop=t;else if(b>list.scrollTop+list.clientHeight)list.scrollTop=b-list.clientHeight}}else input.removeAttribute('aria-activedescendant');
clearTimeout(el._ann);el._ann=setTimeout(()=>FM.announce(items.length?items.length+' player'+(items.length>1?'s':'')+' found':'No players found'),500)}
function open(){list.hidden=false;input.setAttribute('aria-expanded','true');render()}
function close(){list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1}
function pick(i){chosen=items[i];input.value=chosen.name;close();el.dispatchEvent(new CustomEvent('fm-change',{bubbles:true,detail:{value:chosen}}))}
input.addEventListener('input',()=>{chosen=null;active=input.value.trim()?0:-1;open()});
input.addEventListener('click',()=>{if(list.hidden)open()});
input.addEventListener('keydown',e=>{const n=items.length;
if(e.key==='ArrowDown'){e.preventDefault();if(list.hidden){open();active=0;render();return}if(n){active=(active+1)%n;render()}}
else if(e.key==='ArrowUp'){e.preventDefault();if(list.hidden){open();active=n-1;render();return}if(n){active=(active-1+n)%n;render()}}
else if(e.key==='Enter'){if(!list.hidden&&active>=0){e.preventDefault();pick(active)}}
else if(e.key==='Escape'){if(!list.hidden){e.preventDefault();close()}else if(input.value){input.value='';chosen=null}}
else if(e.key==='Tab'){close()}});
list.addEventListener('pointerdown',e=>e.preventDefault());
list.addEventListener('click',e=>{const o=e.target.closest('[role=option]');if(o)pick([...list.children].indexOf(o))});
list.addEventListener('pointermove',e=>{const o=e.target.closest('[role=option]');if(o){const i=[...list.children].indexOf(o);if(i!==active){active=i;render()}}});
input.addEventListener('blur',()=>setTimeout(close,0))};

FM.init=function(root){FM.icons(root);FM.split(root);(root||document).querySelectorAll('[data-code]').forEach(el=>{if(!el._fmCode)FM.code(el)});(root||document).querySelectorAll('[role=menubar]').forEach(el=>{if(!el._fm){el._fm=1;FM.menubar(el)}});(root||document).querySelectorAll('.fm-carousel').forEach(el=>{if(!el._fm){el._fm=1;FM.carousel(el)}});(root||document).querySelectorAll('[data-combobox]').forEach(el=>{if(!el._fm){el._fm=1;FM.combobox(el)}});(root||document).querySelectorAll('[data-datepicker]').forEach(el=>{if(!el._fm){el._fm=1;FM.datepicker(el)}});(root||document).querySelectorAll('[data-scorepad]').forEach(el=>{if(!el._fm){el._fm=1;FM.scorepad(el)}});(root||document).querySelectorAll('[data-select][role=radiogroup],[data-select][role=tablist]').forEach(g=>{const a=attr(g);items(g).forEach(b=>b.tabIndex=b.getAttribute(a)==='true'?0:-1)})};
/* Code input: <div class="fm-code" data-code="6" data-split="3" aria-labelledby="…">. Emits fm-input on every edit and
   fm-change when full. el._fmCode = {invalid(bool), describe(ids), clear()}. Letters and digits only, uppercased. */
FM.code=function(el){const n=+el.dataset.code||6,split=+el.dataset.split||0;el.setAttribute('role','group');let h='';
for(let i=0;i<n;i++){if(split&&i===split)h+='<span class="fm-code__sep" aria-hidden="true"></span>';h+='<input class="fm-input" maxlength="'+n+'" autocapitalize="characters" autocomplete="'+(i?'off':'one-time-code')+'" spellcheck="false" aria-label="Character '+(i+1)+' of '+n+'"'+(el.hasAttribute('data-disabled')?' disabled':'')+'>'}
el.innerHTML=h;const cells=[...el.querySelectorAll('input')];const clean=s=>s.toUpperCase().replace(/[^A-Z0-9]/g,'');const val=()=>cells.map(c=>c.value).join('');
function emit(){cells.forEach(c=>c.removeAttribute('aria-invalid'));el.dispatchEvent(new CustomEvent('fm-input',{bubbles:true,detail:{value:val()}}));if(val().length===n)el.dispatchEvent(new CustomEvent('fm-change',{bubbles:true,detail:{value:val()}}))}
function fill(from,s){s=clean(s);let i=from;for(const ch of s){if(i>=n)break;cells[i++].value=ch}cells[Math.min(i,n-1)].focus();emit()}
cells.forEach((c,i)=>{c.addEventListener('focus',()=>c.select());
c.addEventListener('input',()=>{const v=clean(c.value);if(v.length>1){c.value='';fill(i,v);return}c.value=v;if(v&&i<n-1)cells[i+1].focus();emit()});
c.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!c.value&&i>0){e.preventDefault();cells[i-1].value='';cells[i-1].focus();emit()}else if(e.key==='ArrowLeft'&&i>0){e.preventDefault();cells[i-1].focus()}else if(e.key==='ArrowRight'&&i<n-1){e.preventDefault();cells[i+1].focus()}});
c.addEventListener('paste',e=>{e.preventDefault();fill(i,(e.clipboardData||window.clipboardData).getData('text'))})});
el._fmCode={invalid:b=>cells.forEach(c=>b?c.setAttribute('aria-invalid','true'):c.removeAttribute('aria-invalid')),describe:ids=>cells.forEach(c=>ids?c.setAttribute('aria-describedby',ids):c.removeAttribute('aria-describedby')),clear:()=>{cells.forEach(c=>c.value='');cells[0].focus();emit()}};
if(el.dataset.describedby)el._fmCode.describe(el.dataset.describedby)};

/* Command palette: FM.palette(dialogEl, [{group,label,icon,hint,keywords,run}], {shortcut:true}) → {open(query)}.
   Commands run after the dialog closes so focus can move where the command puts it. */
FM.palette=function(dlg,cmds,opt){opt=opt||{};const uid=nextId('pal');dlg.classList.add('fm-palette');dlg.setAttribute('aria-label','Command palette');
dlg.innerHTML='<div class="fm-palette__search"><span data-icon="search"></span><input role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="'+uid+'-l" aria-label="Search commands and players" placeholder="Type a command or player" autocomplete="off" spellcheck="false"></div><div class="fm-palette__list" id="'+uid+'-l" role="listbox" aria-label="Commands"></div><div class="fm-palette__foot" aria-hidden="true"><span><span class="fm-kbd">↑</span> <span class="fm-kbd">↓</span> move</span><span><span class="fm-kbd">↵</span> run</span><span><span class="fm-kbd">esc</span> close</span></div>';
FM.icons(dlg);const input=dlg.querySelector('input'),list=dlg.querySelector('[role=listbox]');let shown=[],active=0;
function render(){const q=normH(input.value.trim());shown=cmds.filter(c=>!q||normH(c.label+' '+(c.hint||'')+' '+(c.keywords||'')).includes(q));if(active>=shown.length)active=0;
if(!shown.length){list.innerHTML='<div class="fm-combo__empty" role="presentation">No commands or players match “'+escH(input.value.trim())+'”.</div>';input.removeAttribute('aria-activedescendant');return}
let h='',g=null,gi=0;shown.forEach((c,i)=>{if(c.group!==g){if(g!==null)h+='</div>';g=c.group;gi++;h+='<div role="group" aria-labelledby="'+uid+'-g'+gi+'"><div class="fm-palette__group" id="'+uid+'-g'+gi+'" role="presentation">'+escH(g)+'</div>'}
h+='<div class="fm-palette__opt" role="option" id="'+uid+'-o'+i+'" aria-selected="'+(i===active)+'">'+(c.icon?'<span data-icon="'+c.icon+'"></span>':'')+'<span>'+escH(c.label)+'</span>'+(c.hint?'<small>'+escH(c.hint)+'</small>':'')+'</div>'});
list.innerHTML=h+'</div>';FM.icons(list);input.setAttribute('aria-activedescendant',uid+'-o'+active);const a=document.getElementById(uid+'-o'+active);if(a){const t=a.offsetTop,b=t+a.offsetHeight;if(t<list.scrollTop+8)list.scrollTop=t-30;else if(b>list.scrollTop+list.clientHeight)list.scrollTop=b-list.clientHeight}}
function run(i){const c=shown[i];if(!c)return;dlg.close();setTimeout(()=>c.run(),0)}
input.addEventListener('input',()=>{active=0;render()});
input.addEventListener('keydown',e=>{const n=shown.length;if(e.key==='ArrowDown'&&n){e.preventDefault();active=(active+1)%n;render()}else if(e.key==='ArrowUp'&&n){e.preventDefault();active=(active-1+n)%n;render()}else if(e.key==='Enter'){e.preventDefault();run(active)}});
list.addEventListener('pointerdown',e=>e.preventDefault());
list.addEventListener('click',e=>{const o=e.target.closest('[role=option]');if(o)run(+o.id.split('-o').pop())});
list.addEventListener('pointermove',e=>{const o=e.target.closest('[role=option]');if(o){const i=+o.id.split('-o').pop();if(i!==active){active=i;render()}}});
const api={open(q){input.value=q||'';active=0;render();if(!dlg.open)dlg.showModal();input.focus()}};
if(opt.shortcut)document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();dlg.open?dlg.close():api.open()}});
T.palette=async q=>{api.open(q);await paint()};return api};

/* Menubar: <ul class="fm-menubar" role="menubar"> of <li role="none"><button class="fm-menubar__top" aria-controls="menuId"> + <div role="menu" hidden>.
   ← → between menus (open menus follow), ↓/Enter/Space open, ↑ opens at the end, Home/End, Esc closes to the top item. Emits fm-change "Menu → Item". */
FM.menubar=function(bar){const tops=[...bar.querySelectorAll('.fm-menubar__top')];let openI=-1;
tops.forEach((t,i)=>{t.setAttribute('role','menuitem');t.setAttribute('aria-haspopup','menu');t.setAttribute('aria-expanded','false');t.tabIndex=i?-1:0});
const menu=i=>document.getElementById(tops[i].getAttribute('aria-controls'));const its=i=>[...menu(i).querySelectorAll('[role=menuitem]')];
function rove(i){tops.forEach((t,j)=>t.tabIndex=j===i?0:-1)}
function close(focusTop){if(openI<0)return;const i=openI;menu(i).hidden=true;tops[i].setAttribute('aria-expanded','false');openI=-1;if(focusTop)tops[i].focus()}
function open(i,last){close(false);openI=i;rove(i);menu(i).hidden=false;tops[i].setAttribute('aria-expanded','true');const l=its(i);l.forEach(x=>x.tabIndex=-1);const f=last?l[l.length-1]:l[0];if(f)f.focus()}
function step(i,d){const n=(i+d+tops.length)%tops.length;if(openI>=0)open(n);else{rove(n);tops[n].focus()}}
bar.addEventListener('keydown',e=>{const t=e.target.closest('.fm-menubar__top'),it=e.target.closest('[role=menu] [role=menuitem]');
if(t&&!it){const i=tops.indexOf(t);const k={ArrowRight:()=>step(i,1),ArrowLeft:()=>step(i,-1),ArrowDown:()=>open(i),Enter:()=>open(i),' ':()=>open(i),ArrowUp:()=>open(i,true),Home:()=>step(0,0),End:()=>step(tops.length-1,0),Escape:()=>close(true)}[e.key];if(k){e.preventDefault();k()}return}
if(it&&openI>=0){const l=its(openI),k=l.indexOf(it);const f={ArrowDown:()=>l[(k+1)%l.length].focus(),ArrowUp:()=>l[(k-1+l.length)%l.length].focus(),Home:()=>l[0].focus(),End:()=>l[l.length-1].focus(),Escape:()=>close(true),ArrowRight:()=>open((openI+1)%tops.length),ArrowLeft:()=>open((openI-1+tops.length)%tops.length)}[e.key];if(f){e.preventDefault();f()}else if(e.key==='Tab')close(false)}});
bar.addEventListener('click',e=>{const it=e.target.closest('[role=menu] [role=menuitem]');if(it&&openI>=0){const top=tops[openI].textContent.trim();close(true);bar.dispatchEvent(new CustomEvent('fm-change',{bubbles:true,detail:{value:top+' → '+it.textContent.trim()}}));return}
const t=e.target.closest('.fm-menubar__top');if(t){const i=tops.indexOf(t);openI===i?close(true):open(i)}});
bar.addEventListener('pointerover',e=>{const t=e.target.closest('.fm-menubar__top');if(t&&openI>=0&&tops.indexOf(t)!==openI)open(tops.indexOf(t))});
document.addEventListener('pointerdown',e=>{if(openI>=0&&!bar.contains(e.target))close(false)})};

/* Carousel: <section class="fm-carousel" aria-roledescription="carousel"> with [data-prev] [data-next] .fm-carousel__pos .fm-carousel__track. */
FM.carousel=function(el){const tr=el.querySelector('.fm-carousel__track'),prev=el.querySelector('[data-prev]'),next=el.querySelector('[data-next]'),pos=el.querySelector('.fm-carousel__pos');const slides=[...tr.children],n=slides.length;if(!n)return;
slides.forEach((s,i)=>{s.setAttribute('role','group');s.setAttribute('aria-roledescription','slide');s.setAttribute('aria-label',(i+1)+' of '+n)});
const cur=()=>{let k=0;slides.forEach((s,i)=>{if(s.offsetLeft<=tr.scrollLeft+4)k=i});return k};
function upd(){const k=cur(),v=Math.max(1,Math.round(tr.clientWidth/(slides[0].offsetWidth+16))),last=Math.min(n,k+v);pos.textContent=(last>k+1?(k+1)+'–'+last:(k+1))+' of '+n;prev.disabled=tr.scrollLeft<=2;next.disabled=tr.scrollLeft+tr.clientWidth>=tr.scrollWidth-2}
const smooth=()=>!(T.on||matchMedia('(prefers-reduced-motion: reduce)').matches);
const go=d=>{const k=Math.max(0,Math.min(n-1,cur()+d));tr.scrollTo({left:slides[k].offsetLeft,behavior:smooth()?'smooth':'auto'})};
prev.addEventListener('click',()=>go(-1));next.addEventListener('click',()=>go(1));let t;tr.addEventListener('scroll',()=>{clearTimeout(t);t=setTimeout(upd,60)});addEventListener('resize',upd);upd()};

/* Test helpers — call from page.evaluate(). Each returns once the state is painted. */
const $=s=>typeof s==='string'?document.querySelector(s):s;
const paint=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
T.tooltip=async s=>{showTip($(s));await paint()};
T.hideTooltip=async()=>{hideTip();await paint()};
T.openCalendar=async s=>{const el=$(s);const b=el.querySelector('[data-cal-open]');if(b.getAttribute('aria-expanded')!=='true')b.click();await paint()};
T.openCombo=async(s,q)=>{const el=$(s);const i=el.querySelector('input');i.focus();i.value=q||'';i.dispatchEvent(new Event('input',{bubbles:true}));await paint()};
T.toast=async(msg,opt)=>{FM.toast(msg,Object.assign({duration:0},opt));await paint()};
T.dialog=async id=>{document.getElementById(id).showModal();await paint()};
T.clear=async()=>{hideTip();document.querySelectorAll('.fm-toast').forEach(t=>t.remove());document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelectorAll('.fm-cal.fm-overlay').forEach(c=>{c.hidden=true});document.querySelectorAll('[role=combobox]').forEach(i=>i.blur());await paint()};
function only(id){const el=document.querySelector('[data-testid="'+CSS.escape(id)+'"]');if(!el){console.warn('FM: no element with data-testid="'+id+'"');return}document.documentElement.classList.add('fm-only');el.setAttribute('data-fm-only','');for(let p=el.parentElement;p&&p!==document.body;p=p.parentElement)p.setAttribute('data-fm-path','')}
T.ready=new Promise(res=>{const go=()=>{FM.init();if(QS.get('only'))only(QS.get('only'));(document.fonts?document.fonts.ready:Promise.resolve()).then(paint).then(()=>{document.documentElement.dataset.fmReady='true';res()})};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go()});
})();
