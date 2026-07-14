// Slice 14 · ESS services — flow logic (reuses the kit)
function t(k){return window.T[cur.lang][k];}
const ic={
 home:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5"/></svg>',
 clock:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
 doc:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
 bell:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
 card:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20M6 15h4"/></svg>',
 user:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8"/></svg>',
 lock:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="1"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
 ban:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6 18.4 18.4"/></svg>',
 check:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg>',
 x:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6 6 18M6 6l12 12"/></svg>',
 wifi:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01"/></svg>',
 off:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 1l22 22M16.7 11.1A6 6 0 0 0 5 12M8.5 8.5A6 6 0 0 0 5 12M12 20h.01"/></svg>',
 cal:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
 money:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
 cap:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m22 10-10-5L2 10l10 5 10-5z"/><path d="M6 12v5c0 1 3 3 6 3s6-2 6-3v-5"/></svg>',
 shield:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
 chart:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18M8 16v-5M13 16V8M18 16v-9"/></svg>',
 help:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3M12 17h.01"/></svg>',
 dl:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12M7 11l5 4 5-4M5 21h14"/></svg>',
 chev:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 6 6 6-6 6"/></svg>',
 warn:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
 phone:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 1.8L7.6 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 1.8-.6l3 .5a2 2 0 0 1 1.7 2z"/></svg>',
 pin:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.5"/></svg>'};

const initials=n=>n.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
let cur={screen:'home',state:'populated',role:'R13',theme:'light',surface:'mobile',lang:'en'};
const META={
 home:{ic:ic.home,t:'home',s:'homeSub'}, docs:{ic:ic.doc,t:'docs',s:'docsSub'},
 notifs:{ic:ic.bell,t:'notifs',s:'notifsSub'}, idcard:{ic:ic.card,t:'idcard',s:'idcardSub'},
 gate:{ic:ic.user,t:'gate',s:'gateSub'}, blocked:{ic:ic.lock,t:'blocked',s:'blockedSub'}};

function app(netOff,body){
 const m=META[cur.screen];
 const net=netOff?`<span class="net off">${ic.off}${t('offline')}</span>`:`<span class="net">${ic.wifi}${t('online')}</span>`;
 return `<div class="app"><div class="topbar">${m.ic}<div><div class="tt">${t(m.t)}</div><div class="ts">${t(m.s)}</div></div>${net}</div>
  <div class="body">${body}</div></div>`;
}
function center(icCls,icon,title,body,extra){return `<div class="center"><span class="ic ${icCls||''}">${icon}</span><h3>${title}</h3><p>${body}</p>${extra||''}</div>`;}
const offBanner=()=>`<div class="banner off">${ic.off}<div><b>${t('offT')}</b><br>${t('offB')}</div></div>`;
function loadingFrame(){return app(false,`${'<div class="skelrow" style="margin-bottom:12px"></div>'.repeat(3)}<div class="skelrow" style="height:120px;margin-bottom:12px"></div>${'<div class="skelrow" style="margin-bottom:12px"></div>'.repeat(3)}`);}
function errFrame(){return app(false,center('err',ic.warn,t('errT'),t('errB'),`<button class="btn p" style="background:var(--red)">${ic.chev} ${t('retry')}</button>`));}
function noPermFrame(){return app(false,center('warn',ic.lock,t('noPermT'),t('noPermB'),`<button class="btn g">${ic.phone} ${t('contactHr')}</button>`));}

// generic state gate; returns null if the screen should render its own body
function genericState(){
 if(cur.state==='loading') return loadingFrame();
 if(cur.state==='error') return errFrame();
 if(cur.state==='no-permission') return noPermFrame();
 return null;
}

// ── E2 Home ──
function homeScreen(){
 const off=cur.state==='offline';
 if(cur.state==='empty') return app(false,center('',ic.home,t('homeEmptyT'),t('homeEmptyB')));
 const hero=`<div class="hero"><span class="av">${initials(t('wname'))}</span><div><div class="hi">${t('greet')}, ${t('wname').split(' ')[0]}</div><div class="sub">${t('wno')} · ${t('wrole')} · ${t('wsite')}</div></div></div>`;
 const clock=`<div class="clockchip on"><span class="ci">${ic.check}</span><div><div class="ct">${t('clockedIn')}</div><div class="cd">${t('clockedInD')}</div></div><span class="cb">${t('view')}</span></div>`;
 const tiles=[[ic.cal,'qaLeave'],[ic.doc,'qaDocs'],[ic.money,'qaPayslip'],[ic.cap,'qaTraining'],[ic.shield,'qaPolicies',1],[ic.card,'qaId'],[ic.chart,'qaPerf'],[ic.help,'qaSupport']];
 const qa=`<div class="shead">${ic.home} ${t('quick')}</div><div class="qagrid">${tiles.map(([i,k,b])=>`<div class="qa">${b?`<span class="badge2">${b}</span>`:''}<span class="qai">${i}</span><span class="qal">${t(k)}</span></div>`).join('')}</div>`;
 const acts=[['green',ic.cal,'actLeave','actLeaveT'],['blue',ic.money,'actPay','actPayT'],['amber',ic.shield,'actPol','actPolT'],['blue',ic.clock,'actClock','actClockT']];
 const many=cur.state==='large-data';
 const feedRows=(many?[...acts,...acts,...acts]:acts).map(([tone,i,k,tk],x)=>`<div class="pitem"><span class="pi ${tone==='blue'?'out':'in'}">${i}</span><div style="flex:1"><div class="pt">${t(k)}</div><div class="pd">${t(tk)}</div></div></div>`).join('');
 const feed=`<div class="shead">${ic.clock} ${t('activity')}${many?' · '+ (cur.lang==='en'?'full history':'historia kamili'):''}</div><div class="plist">${feedRows}</div>`;
 const outstanding=`<div class="shead">${ic.warn} ${t('outstanding')}</div>
  <div class="banner info" style="margin-bottom:8px">${ic.shield}<div>${t('outPol')}</div></div>
  <div class="banner off">${ic.cap}<div>${t('outCert')}</div></div>`;
 const okb=cur.state==='success'?`<div class="banner ok">${ic.check}<div>${t('successT')}</div></div>`:'';
 return app(off,`${off?offBanner():okb}${hero}${clock}${qa}${outstanding}${feed}`);
}

// ── E5 Documents ──
function docsScreen(){
 const off=cur.state==='offline';
 if(cur.state==='empty') return app(false,center('',ic.doc,t('docsEmptyT'),t('docsEmptyB')));
 const base=[
  [ic.money,'dPayJun','dPaySub','dl'],[ic.money,'dPayMay','dPaySub','dl'],
  [ic.doc,'dContract','dContractSub','dl'],[ic.shield,'dCert','dCertSub','dl'],
  [ic.warn,'dWarn','dWarnSub','conf'],[ic.card,'dId','dIdSub','dl']];
 const many=cur.state==='large-data';
 const list=(many?[...Array(6)].flatMap((_,i)=>[[ic.money,'dPayJun','dPaySub','dl']]).concat(base):base);
 const rows=list.map(([i,k,sub,act])=>`<div class="docrow"><span class="di">${i}</span>
   <div style="flex:1"><div class="dt">${t(k)}</div><div class="dd">${t(sub)}</div></div>
   ${act==='conf'?`<span class="dlock">${ic.lock} ${t('docLocked')}</span>`:off&&k==='dPayJun'?`<span class="dlock">${t('downloadQ')}</span>`:`<span class="dact">${ic.dl}</span>`}</div>`).join('');
 const head=`<div class="shead">${ic.doc} ${t('docs')}${many?' · '+(cur.lang==='en'?'all periods':'vipindi vyote'):''}</div>`;
 const okb=cur.state==='success'?`<div class="banner ok">${ic.check}<div>${t('successT')}</div></div>`:'';
 return app(off,`${off?offBanner():okb}${head}<div class="doclist">${rows}</div>`);
}

// ── E10 Notifications ──
function notifsScreen(){
 const off=cur.state==='offline';
 if(cur.state==='empty') return app(false,center('',ic.bell,t('notifsEmptyT'),t('notifsEmptyB')));
 const allread=cur.state==='success';
 const base=[
  ['leave',ic.cal,'nLeave','nLeaveB',1],['pay',ic.money,'nPay','nPayB',1],
  ['policy',ic.shield,'nPolicy','nPolicyB',1],['train',ic.cap,'nTraining','nTrainingB',0],
  ['clock',ic.clock,'nClock','nClockB',0]];
 const many=cur.state==='large-data';
 const list=many?[...base,...base,...base]:base;
 const rows=list.map(([id,i,k,b,unread])=>{const u=unread&&!allread;
  return `<div class="qitem" style="align-items:flex-start;${u?'border-left:3px solid var(--green)':''}"><span class="qi">${i}</span>
   <div style="flex:1"><div class="qt">${t(k)}${u?' <span style="color:var(--green);font-size:9px">●</span>':''}</div><div class="qd" style="white-space:normal;color:var(--muted);font-family:var(--font);font-weight:400;font-size:11.5px;margin-top:3px">${t(b)}</div></div></div>`;}).join('');
 const unreadN=allread?0:base.filter(x=>x[4]).length*(many?3:1);
 const head=`<div class="rmeta" style="margin-bottom:2px"><span class="shead" style="margin:0">${ic.bell} ${unreadN} ${t('unread')}</span>${unreadN?`<span class="scope" style="cursor:default">${ic.check} ${t('markRead')}</span>`:''}</div>`;
 const foot=`<div class="note">${ic.shield}<span>${t('synced')} · UNI-01</span></div>`;
 return app(off,`${off?offBanner():''}${head}<div class="plist" style="gap:8px">${rows}</div>${foot}`);
}

// ── E11 Digital ID card ──
function qr(){
 const p=[[1,1,1,1,1,1,1,0,1,0,1,1,1,1,1,1,1],[1,0,0,0,0,0,1,0,0,1,1,0,0,0,0,0,1],[1,0,1,1,1,0,1,0,1,0,1,0,1,1,1,0,1],[1,0,1,1,1,0,1,1,0,1,0,1,1,1,1,0,1],[1,0,1,1,1,0,1,0,1,1,1,0,1,1,1,0,1],[1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0,1],[1,1,1,1,1,1,1,0,1,0,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],[1,0,1,1,0,1,1,1,0,1,1,0,1,0,1,1,0],[0,1,0,1,1,0,0,1,1,0,1,1,0,1,0,0,1],[1,1,0,0,1,1,1,0,0,1,0,1,1,0,1,1,0],[0,0,0,0,0,0,0,1,1,0,1,0,0,1,0,1,1],[1,1,1,1,1,1,1,0,0,1,1,1,0,1,1,0,0],[1,0,0,0,0,0,1,0,1,0,0,1,0,0,1,1,0],[1,0,1,1,1,0,1,1,1,1,0,1,1,1,0,0,1],[1,0,1,1,1,0,1,0,0,1,1,0,1,0,1,1,0],[1,0,0,0,0,0,1,1,0,1,0,1,0,1,1,0,1]];
 let r='';p.forEach((row,y)=>row.forEach((c,x)=>{if(c)r+=`<rect x="${x}" y="${y}" width="1" height="1"/>`;}));
 return `<svg viewBox="0 0 17 17" fill="#08311E">${r}</svg>`;
}
function idCardBody(){
 const F=(k,v,mono)=>`<div class="idrow"><div class="k">${t(k)}</div><div class="v ${mono?'mono':''}">${v}</div></div>`;
 return `<div class="idc"><div class="idh"><span class="lg">${ic.shield}</span><div><div class="co">${t('idCo')}</div><div class="cs">${t('idKind')}</div></div></div>
  <div class="idb"><div class="photo">${t('idPhoto')}</div>
   <div class="idf">${F('idName',t('wname'))}${F('idNo',t('wno'),1)}${F('idRole',t('wrole'))}${F('idSite',t('wsite'))}</div></div>
  <div class="idftr"><div class="qr">${qr()}</div><div class="idval">${t('idValid')}: 31 Dec 2026<br>${t('idIssued')}: 12 Jan 2022<br>${t('idScan')}</div></div></div>`;
}
function idScreen(){
 const off=cur.state==='offline';
 if(cur.state==='empty') return app(false,center('',ic.card,t('idEmptyT'),t('idEmptyB')));
 const okb=cur.state==='success'?`<div class="banner ok">${ic.check}<div>${t('successT')}</div></div>`:'';
 const offb=off?`<div class="banner off">${ic.off}<div>${t('idScan')} · ${t('offT')}</div></div>`:'';
 return app(off,`${offb}${okb}${idCardBody()}
   <button class="btn p block" style="margin-top:2px">${ic.dl} ${t('idAdd')}</button>
   <div class="note">${ic.shield}<span>${t('idNote')}</span></div>`);
}

// ── E13 Profile gate ──
function gateScreen(){
 const off=cur.state==='offline';
 const done=cur.state==='success';
 if(done) return app(false,center('',ic.check,t('gateDone'),t('gateDoneB'),`<div class="progline" style="width:80%;margin-top:6px"><div class="fillp" style="width:100%"></div></div>`));
 const items=[['ok','gContact','gContactD'],['ok','gNida','gNidaD'],['miss','gNextKin','gNextKinD'],['miss','gBank','gBankD'],['miss','gPhoto','gPhotoD']];
 const okN=items.filter(i=>i[0]==='ok').length, pct=Math.round(okN/items.length*100);
 const rows=items.map(([st,k,d])=>`<div class="gaterow"><span class="gi ${st}">${st==='ok'?ic.check:ic.x}</span>
   <div style="flex:1"><div class="gt">${t(k)}</div><div class="gd">${t(d)}</div></div>
   <span class="gtag ${st}">${st==='ok'?t('gDone'):t('gMissing')}</span></div>`).join('');
 const head=`<div class="banner off">${ic.lock}<div><b>${t('gateT')}</b><br>${t('gateB')}</div></div>
  <div class="progline"><div class="fillp" style="width:${pct}%"></div></div>
  <div class="rmeta"><span>${okN}/${items.length} ${t('gComplete')}</span><span class="cnt">${pct}%</span></div>`;
 return app(off,`${off?offBanner():''}${head}<div class="gate">${rows}</div>
  <button class="btn p block">${ic.user} ${t('gateCta')}</button>`);
}

// ── E14 Blocked ──
function blockedScreen(){
 const term=cur.state==='no-permission';
 const off=cur.state==='offline';
 if(cur.state==='loading') return loadingFrame();
 const icon=term?ic.ban:ic.lock;
 return app(off,`${off?offBanner():''}${center(term?'err':'warn',icon,term?t('blTermT'):t('blSuspT'),term?t('blTermB'):t('blSuspB'),
  `<div class="why">${term?t('blTermWhy'):t('blSuspWhy')}</div><button class="btn g">${ic.phone} ${t('contactHr')}</button>`)}`);
}

// ── render ──
function render(){
 let html;
 const g=(cur.screen==='blocked')?null:genericState();
 if(g) html=g;
 else if(cur.screen==='home') html=homeScreen();
 else if(cur.screen==='docs') html=docsScreen();
 else if(cur.screen==='notifs') html=notifsScreen();
 else if(cur.screen==='idcard') html=idScreen();
 else if(cur.screen==='gate') html=gateScreen();
 else html=blockedScreen();
 document.querySelector('.stage').innerHTML=`<div class="frame">${html}</div>`;
}

// ── switcher bar ──
function seg(id,items,key){const el=document.getElementById(id);el.innerHTML=items.map(it=>{const v=Array.isArray(it)?it[0]:it,l=Array.isArray(it)?it[1]:it;return `<button data-v="${v}">${l}</button>`;}).join('');el.querySelectorAll('button').forEach(b=>b.onclick=()=>{cur[key]=b.getAttribute('data-v');sync();});}
const AC={home:'UNI-01 · A2 landing',docs:'DOC · PRT-02 · A3 confidential',notifs:'UNI-01 ESS↔HCMOS sync',idcard:'PRT-01 · A3 permitted fields',gate:'UNI-01 · profile completeness gate',blocked:'AUTH-04 · DISC-03 · LVR-01'};
function sync(){
 document.documentElement.setAttribute('data-theme',cur.theme);
 document.documentElement.setAttribute('data-surface',cur.surface);
 [['screens','screen'],['states','state'],['roles','role'],['themes','theme'],['surfaces','surface'],['langs','lang']].forEach(([id,k])=>document.querySelectorAll('#'+id+' button').forEach(b=>b.classList.toggle('on',b.getAttribute('data-v')===cur[k])));
 document.getElementById('acline').innerHTML=`Covers <b>${AC[cur.screen]}</b> · ${cur.theme}/${cur.surface} · viewer ${cur.role} · ${t('reg')}`;
 render();
}
seg('screens',[['home','Home'],['docs','Documents'],['notifs','Notifications'],['idcard','ID card'],['gate','Profile gate'],['blocked','Blocked']],'screen');
seg('states',[['empty','empty'],['loading','loading'],['populated','populated'],['large-data','large-data'],['error','error'],['no-permission','no-perm'],['offline','offline'],['success','success']],'state');
seg('roles',['R01','R02','R03','R04','R05','R06','R07','R08','R09','R10','R11','R12','R13'].map(r=>[r,r]),'role');
seg('themes',[['light','Light'],['dark','Dark'],['glass','Glass'],['reduced','Reduced']],'theme');
seg('surfaces',[['desktop','Desk'],['tablet','Tablet'],['mobile','Mobile'],['kiosk','Kiosk']],'surface');
seg('langs',[['en','EN'],['sw','SW']],'lang');
sync();
