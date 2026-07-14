// Slice 5 · E3 Attendance (clock in/out · geofence · offline) — flow logic (reuses Slice-4 kit)
function t(k){return window.T[cur.lang][k];}

const ic={
 clock:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
 target:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 1v3M12 20v3M23 12h-3M4 12H1"/></svg>',
 pin:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.5"/></svg>',
 check:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg>',
 x:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6 6 18M6 6l12 12"/></svg>',
 warn:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
 off:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 1l22 22M16.7 11.1A6 6 0 0 0 5 12M8.5 8.5A6 6 0 0 0 5 12M2 8.8A11 11 0 0 1 6 6M22 8.8a11 11 0 0 0-4.6-3.3M12 20h.01"/></svg>',
 wifi:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01"/></svg>',
 sync:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></svg>',
 cloud:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 18a4 4 0 0 0 0-8 6 6 0 0 0-11.6-1.5A4.5 4.5 0 0 0 6.5 18z"/></svg>',
 shield:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
 lock:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="1"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
 search:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
 users:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11"/></svg>',
 calendar:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
 login:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>',
 logout:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
 device:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>'};

const initials=n=>n.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();

let cur={screen:'clockin',state:'success',role:'R13',theme:'light',surface:'mobile',lang:'en'};

const WORKER={n:'Peter Komba',no:'TMCL-MW-2210'};
const OPERATOR={n:'Grace Ndaki',r:'Site Supervisor'};
const DATE='29 Jun 2026';
const T_IN='07:02', T_OUT='17:04', WORKED='10h 02m';
const isOut=()=>cur.screen==='clockout';

// ── app shell ──
function app(title,sub,netOff,bodyHTML,operator){
 const net=netOff
  ?`<span class="net off">${ic.off}${cur.lang==='en'?'Offline':'Nje ya mtandao'}</span>`
  :`<span class="net">${ic.wifi}${cur.lang==='en'?'Online':'Mtandaoni'}</span>`;
 const op=operator&&cur.surface==='kiosk'
  ?`<div class="shiftbar" style="border-color:rgba(0,148,212,.3);background:rgba(0,148,212,.06)"><span class="av" style="background:var(--blue)">${initials(OPERATOR.n)}</span><div><div class="nm">${OPERATOR.n}</div><div class="mt">${t('operator')} · ${OPERATOR.r}</div></div><span class="flag" style="margin-left:auto;background:rgba(0,148,212,.12);color:var(--blue);border-color:rgba(0,148,212,.3)">${ic.users}${t('kioskTitle')}</span></div>`
  :'';
 return `<div class="app"><div class="topbar">${ic.clock}<div><div class="tt">${title}</div><div class="ts">${sub}</div></div>${net}</div>
  <div class="body">${op}${bodyHTML}</div></div>`;
}

// ── shift context ──
function shiftBar(status){
 const on=status!=='off';
 return `<div class="shiftbar"><span class="av" style="${on?'':'background:var(--faint)'}">${initials(WORKER.n)}</span>
  <div><div class="nm">${WORKER.n}</div><div class="mt">${WORKER.no} · ${t('workerRole')}</div></div>
  <div class="st"><div class="lbl">${t('shift')}</div><div class="val">${t('dayShift')}</div></div></div>
  <div class="stat3"><div class="c"><div class="lbl">${t('statusLbl')}</div><div class="val ${on?'g':''}">${on?t('onShift'):t('offShift')}</div></div>
   <div class="c"><div class="lbl">${t('since')}</div><div class="val num">${on?T_IN:t('na')}</div></div>
   <div class="c"><div class="lbl">${t('todayLbl')}</div><div class="val num">${on?WORKED:'0h'}</div></div></div>`;
}

// ── geofence radar ──
function geoPanel(mode){ // 'pass' | 'fail' | 'locating' | 'coarse'
 const bad=mode==='fail', loc=mode==='locating', coarse=mode==='coarse';
 return `<div class="geo">
  ${loc||coarse?'':`<div class="pulse ${bad?'out':''}"></div>`}
  ${coarse?'<div class="halo"></div>':''}
  <div class="bound ${bad?'bad':''} ${coarse?'warn':''}"></div>
  ${loc?`<div class="skelrow" style="width:120px;height:120px;border-radius:50%"></div>`:`<div class="you ${bad?'out':''} ${coarse?'coarse':''}"></div>`}
  <div class="locbadge ${coarse?'bad':''}">${loc?t('geoLocating'):coarse?t('capAccBadVal'):t('capAcc')+' '+t('capAccVal')}</div>
  ${loc?'':coarse?`<div class="gtag warn"><span class="dot"></span>${t('geoCoarse')}</div>`:`<div class="gtag ${bad?'bad':'ok'}"><span class="dot"></span>${bad?t('geoOutside'):t('geoWithin')}</div>`}
 </div>`;
}
const ssFlag=()=>`<span class="flag"><span class="dot"></span>${t('ssTag')}</span>`;

// ── capture receipt ──
function receipt(opts){ // {offline, out}
 const rows=[
  [t('capTime'),`${DATE} · ${opts.out?T_OUT:T_IN}`,false],
  [t('capFix'),t('capFixVal'),true],
  [t('capAcc'),t('capAccVal'),false],
  [t('capBoundary'),ssFlag(),false]
 ];
 if(opts.offline) rows.push([t('offKey'),'att-1f9c-77e2',false]);
 return `<div class="receipt"><div class="rh">${ic.pin} ${t('capTitle')}</div>
  ${rows.map(([k,v,d])=>`<div class="rr"><span class="k">${k}</span><span class="v ${d?'d':''}">${v}</span></div>`).join('')}</div>`;
}
function auditRow(){return `<div class="audit">${ic.shield}<span>${t('auditExt')}</span><span class="h">#7b2e…c4</span></div>`;}
function ssNote(){return `<div class="note">${ic.warn}<span>${t('ssNote')}</span></div>`;}

// ── recent punches ──
function recent(){
 const items=[['out',t('rOut'),'yesterday',T_OUT],['in',t('rIn'),`yesterday · ${t('rInside')}`,T_IN]];
 return `<div class="shead">${ic.clock} ${t('recent')}</div><div class="plist">${items.map(([k,lbl,sub,tm])=>
  `<div class="pitem"><span class="pi ${k}">${k==='in'?ic.login:ic.logout}</span>
   <div style="flex:1"><div class="pt">${lbl}</div><div class="pd">${sub}</div></div><span class="ptime num">${tm}</span></div>`).join('')}</div>`;
}

// ── large-data assisted roster ──
function rosterBody(){
 const crew=[['Peter Komba','TMCL-MW-2210'],['Amina Juma','TMCL-MW-3341'],['Joseph Mlimani','TMCL-MW-4821'],
  ['Fatuma Chacha','TMCL-MW-4110'],['Salum Rajabu','TMCL-MW-5507'],['Neema Kije','TMCL-MW-6018'],['Hamisi Ally','TMCL-MW-6642']];
 return `<div class="rsearch">${ic.search}<span>${t('rosterSearch')}</span></div>
  <div class="rmeta"><span>${t('rosterHint')}</span><span class="cnt">${t('rosterCount')}</span></div>
  <div class="roster">${crew.map(([n,no])=>`<div class="rrow"><span class="av">${initials(n)}</span>
   <div style="flex:1"><div class="rn">${n}</div><div class="rs">${no}</div></div><span class="rb">${t('punchIn')}</span></div>`).join('')}
   <div class="vhint">${t('rosterShown')}</div></div>
  <div class="note">${ic.shield}<span>${t('assistNote')}</span></div>`;
}

// ── center-panel helper (empty / lock / error) ──
function center(icCls,icon,title,body,extra){
 return `<div class="center"><span class="ic ${icCls||''}">${icon}</span><h3>${title}</h3><p>${body}</p>${extra||''}</div>`;
}

// ── clock in / out screen ──
function clockScreen(){
 const out=isOut();
 const title=out?t('clockout'):t('clockin'), sub=out?t('clockoutSub'):t('clockinSub');
 const wrap=b=>app(title,sub,cur.state==='offline',b,true);
 switch(cur.state){
  case 'empty':
   return wrap(center('',ic.calendar,out?t('emptyOutTitle'):t('emptyInTitle'),out?t('emptyOutBody'):t('emptyInBody')));
  case 'loading':
   return wrap(`${shiftBar(out?'on':'off')}${geoPanel('locating')}
    <div class="receipt"><div class="rh">${ic.pin} ${t('capTitle')}</div>
     ${'<div class="rr"><div class="skelrow" style="width:100%"></div></div>'.repeat(3)}</div>
    <button class="punch wait" disabled>${ic.sync} ${t('capturing')}</button>`);
  case 'success':{
   const disc=out?'ok':'ok';
   return wrap(`<div class="seal"><span class="disc ${disc}">${ic.check}</span>
     <h3>${out?t('successOutTitle'):t('successInTitle')}</h3>
     <div class="big">${out?T_OUT:T_IN}</div>
     <p>${out?`${t('successOutSub')} · ${WORKED} ${t('worked')}.`:t('successInSub')}</p></div>
    ${geoPanel('pass')}${receipt({out})}${auditRow()}${recent()}`);
  }
  case 'error':
   return wrap(`${shiftBar(out?'on':'off')}
    <div class="banner err">${ic.warn}<div><b>${t('errTitle')}</b><br>${t('errBody')}</div></div>
    ${geoPanel('locating')}
    <button class="btn p block" style="background:var(--red)">${ic.sync} ${t('retry')}</button>`);
  case 'low-accuracy':
   return wrap(`${shiftBar(out?'on':'off')}
    <div class="banner warn">${ic.warn}<div><b>${t('lowAccTitle')}</b><br>${t('lowAccBody')}</div></div>
    ${geoPanel('coarse')}
    <div class="receipt"><div class="rh">${ic.target} ${t('capTitle')}</div>
     <div class="rr"><span class="k">${t('capAcc')}</span><span class="v" style="color:#9A6B00">${t('capAccBadVal')}</span></div>
     <div class="rr"><span class="k">${t('accTol')}</span><span class="v d">${t('accTolVal')}</span></div>
     <div class="rr"><span class="k">${t('capBoundary')}</span><span class="v">${ssFlag()}</span></div></div>
    <div class="note">${ic.shield}<span>${t('lowAccNote')}</span></div>
    <button class="btn w block">${ic.sync} ${t('retryFix')}</button>`);
  case 'no-permission':
   return wrap(center('warn',ic.pin,t('noPermTitle'),t('noPermBody'),
    `<div class="why">${t('noPermWhy')}</div><button class="btn b">${ic.target} ${t('enableLoc')}</button>`));
  case 'offline':
   return wrap(`<div class="banner off">${ic.off}<div><b>${t('offTitle')}</b><br>${t('offBody')}</div></div>
    ${geoPanel('pass')}${receipt({out,offline:true})}
    <button class="punch wait" disabled>${ic.cloud} ${t('queuedBtn')}</button>
    <div class="note">${ic.shield}<span>${t('capServer')} · ${t('auditExt')}</span></div>`);
  case 'large-data':
   return app(t('kioskTitle'),t('kioskSub'),false,rosterBody(),true);
  case 'conflict':
   return wrap(`${shiftBar(out?'on':'off')}
    <div class="banner err">${ic.warn}<div>${t('conflictInline')}</div></div>
    <div class="qitem conflict"><span class="qi">${ic.login}</span>
     <div style="flex:1"><div class="qt">${WORKER.n} · ${t('rIn')}</div><div class="qd">${DATE} · ${T_IN} · att-1f9c-77e2</div></div>
     <span class="qs conflict"><span class="dot"></span>${t('stConflict')}</span></div>
    <button class="btn b block" onclick="cur.screen='sync';cur.state='conflict';sync()">${ic.sync} ${t('goToSync')}</button>`);
  default:
   return wrap(`${shiftBar(out?'on':'off')}${geoPanel('pass')}${receipt({out})}
    <button class="punch ${out?'out':'in'}">${out?ic.logout:ic.login} ${out?t('clockOutNow'):t('clockInNow')}</button>`);
 }
}

// ── geofence treatment showcase ──
function geoScreen(){
 const passCard=`<div class="showcard"><div class="sc-h ok">${ic.check} ${t('geoWithin')}</div>
   <div class="sc-b">${geoPanel('pass')}
    <div class="receipt"><div class="rr"><span class="k">${t('capFix')}</span><span class="v d">${t('capFixVal')}</span></div>
     <div class="rr"><span class="k">${t('capAcc')}</span><span class="v">${t('capAccVal')}</span></div>
     <div class="rr"><span class="k">${t('capBoundary')}</span><span class="v">${ssFlag()}</span></div></div></div></div>`;
 const failCard=`<div class="showcard"><div class="sc-h bad">${ic.warn} ${t('geoOutside')}</div>
   <div class="sc-b">${geoPanel('fail')}
    <div class="note">${ic.warn}<span>${t('deviceOnlyNote')}</span></div></div></div>`;
 const coarseCard=`<div class="showcard"><div class="sc-h" style="color:#9A6B00">${ic.warn} ${t('geoCoarse')}</div>
   <div class="sc-b">${geoPanel('coarse')}
    <div class="note">${ic.shield}<span>${t('coarseCardNote')}</span></div></div></div>`;
 const boundaryBlock=`<div class="receipt"><div class="rh">${ic.target} ${t('boundaryField')}</div>
   <div class="rr"><span class="k">${t('capBoundary')}</span><span class="v">${ssFlag()}</span></div>
   <div class="rr"><span class="k">${t('boundaryField')}</span><span class="v d">${t('boundaryVal')}</span></div></div>`;
 return app(t('geofence'),t('geofenceSub'),false,
  `<div class="showgrid">${passCard}${failCard}${coarseCard}</div>
   ${boundaryBlock}${ssNote()}
   <div class="banner info">${ic.shield}<div><b>${t('deviceOnly')}.</b> ${t('deviceOnlyNote')}</div></div>`);
}

// ── sync queue + conflict ──
const QUEUE=[
 {who:'Peter Komba',kind:'in',time:`${DATE} · ${T_IN}`,key:'att-1f9c-77e2',ref:'ATT-2026-08841'},
 {who:'Amina Juma',kind:'in',time:`${DATE} · 07:05`,key:'att-2a03-40b1',ref:'ATT-2026-08842'},
 {who:'Joseph Mlimani',kind:'out',time:`${DATE} · ${T_OUT}`,key:'att-9c7d-1e55',ref:'ATT-2026-08843'}];
function qitem(p,status){
 const lbl={queued:t('stQueued'),syncing:t('stSyncing'),synced:t('stSynced'),conflict:t('stConflict')}[status];
 const meta=status==='synced'?`${t('serverRef')} ${p.ref}`:`${t('offKey')} ${p.key}`;
 return `<div class="qitem ${status==='conflict'?'conflict':''}"><span class="qi">${p.kind==='in'?ic.login:ic.logout}</span>
  <div style="flex:1"><div class="qt">${p.who} · ${p.kind==='in'?t('rIn'):t('rOut')}</div><div class="qd">${meta}</div></div>
  <span class="qs ${status}"><span class="dot"></span>${lbl}</span></div>`;
}
function conflictBody(){
 return `<div class="confhead"><span class="seal2">${ic.warn}</span>
   <div><div class="ht">${t('conflictTitle')}</div><div class="hs">${t('conflictKind')}</div></div></div>
  <div class="banner info">${ic.shield}<div>${t('conflictBody')}</div></div>
  <div class="versus">
   <div class="ver dev"><div class="vl">${ic.device} ${t('verDevice')}</div><div class="vtime num">${T_IN}</div>
    <div class="vsub">${t('verVia')} ${t('viaPhone')}</div><div class="vkey">att-1f9c-77e2</div></div>
   <div class="ver"><div class="vl">${ic.cloud} ${t('verServer')}</div><div class="vtime num">06:58</div>
    <div class="vsub">${t('verVia')} ${t('viaKiosk')}</div><div class="vkey">ATT-2026-08822</div></div></div>
  <div class="choices">
   <div class="choice sel"><span class="rad"></span><div><div class="ct">${t('keepDevice')}</div><div class="cd">${DATE} · ${T_IN} · ESS</div></div></div>
   <div class="choice"><span class="rad"></span><div><div class="ct">${t('keepServer')}</div><div class="cd">${DATE} · 06:58 · kiosk</div></div></div>
   <div class="choice"><span class="rad"></span><div><div class="ct">${t('keepBoth')}</div><div class="cd">${t('resolveHint')}</div></div></div></div>
  <div class="audit">${ic.shield}<span>${t('auditExt')}</span></div>
  <button class="btn b block">${ic.check} ${t('resolve')}</button>`;
}
function syncScreen(){
 const wrap=(netOff,b)=>app(t('sync'),t('syncSub'),netOff,b,false);
 switch(cur.state){
  case 'empty':
   return wrap(false,center('',ic.cloud,t('syncEmptyTitle'),t('syncEmptyBody')));
  case 'offline':
   return wrap(true,`<div class="banner off">${ic.off}<div>${t('queuedBanner')}</div></div>
    ${QUEUE.map(p=>qitem(p,'queued')).join('')}
    <button class="btn g block" disabled>${ic.sync} ${t('syncNow')}</button>`);
  case 'loading':
   return wrap(false,`<div class="banner info">${ic.sync}<div>${t('syncingBanner')}</div></div>
    ${qitem(QUEUE[0],'synced')}${qitem(QUEUE[1],'syncing')}${qitem(QUEUE[2],'queued')}`);
  case 'success':
   return wrap(false,`<div class="banner ok">${ic.check}<div>${t('syncedBanner')}</div></div>
    ${QUEUE.map(p=>qitem(p,'synced')).join('')}${auditRow()}
    <div class="note">${ic.shield}<span>${t('dedupeNote')}</span></div>`);
  case 'error':
   return wrap(false,`<div class="banner err">${ic.warn}<div><b>${t('syncErrTitle')}</b><br>${t('syncErrBody')}</div></div>
    ${QUEUE.map(p=>qitem(p,'queued')).join('')}
    <button class="btn b block">${ic.sync} ${t('retrySync')}</button>`);
  case 'no-permission':
   return wrap(true,`<div class="banner off">${ic.off}<div>${t('queuedBanner')}</div></div>
    ${QUEUE.map(p=>qitem(p,'queued')).join('')}
    <div class="note">${ic.pin}<span>${t('noPermBody')}</span></div>`);
  case 'large-data':
   return wrap(true,`<div class="banner info">${ic.cloud}<div><b>${t('largeBatchTitle')}.</b> ${t('largeBatchBody')}</div></div>
    <div class="qitem"><span class="qi">${ic.users}</span><div style="flex:1"><div class="qt">${t('largeBatchTitle')} · Mwadui</div>
     <div class="qd">${t('batchCount')}</div></div><span class="qs queued"><span class="dot"></span>${t('stQueued')}</span></div>
    ${qitem(QUEUE[0],'queued')}${qitem(QUEUE[1],'queued')}
    <div class="vhint">+ 146 ${cur.lang==='en'?'more · batched':'zaidi · fungu'}</div>
    <button class="btn g block" disabled>${ic.sync} ${t('syncNow')}</button>
    <div class="note">${ic.shield}<span>${t('dedupeNote')}</span></div>`);
  case 'conflict':
   return wrap(false,conflictBody());
  default:
   return wrap(true,`<div class="banner off">${ic.off}<div>${t('queuedBanner')}</div></div>${QUEUE.map(p=>qitem(p,'queued')).join('')}`);
 }
}

// ── render ──
function render(){
 let html;
 if(cur.screen==='geofence') html=geoScreen();
 else if(cur.screen==='sync') html=syncScreen();
 else html=clockScreen();
 document.querySelector('.stage').innerHTML=`<div class="frame">${html}</div>`;
}

// ── switcher bar ──
function seg(id,items,key){const el=document.getElementById(id);el.innerHTML=items.map(it=>{const v=Array.isArray(it)?it[0]:it,l=Array.isArray(it)?it[1]:it;return `<button data-v="${v}">${l}</button>`;}).join('');el.querySelectorAll('button').forEach(b=>b.onclick=()=>{cur[key]=b.getAttribute('data-v');sync();});}
const AC={
 clockin:'AC-ATT-01 · UNI-01 offline · UNI-06',
 clockout:'AC-ATT-02 · UNI-01 offline · UNI-06',
 geofence:'AC-ATT-03 · SS-3 [Open] · device-side capture',
 sync:'AC-UNI-01 offline queue · UNI-06 audit'};
function sync(){
 document.documentElement.setAttribute('data-theme',cur.theme);
 document.documentElement.setAttribute('data-surface',cur.surface);
 [['screens','screen'],['states','state'],['roles','role'],['themes','theme'],['surfaces','surface'],['langs','lang']].forEach(([id,k])=>document.querySelectorAll('#'+id+' button').forEach(b=>b.classList.toggle('on',b.getAttribute('data-v')===cur[k])));
 document.getElementById('acline').innerHTML=`Covers <b>${AC[cur.screen]}</b> · ${cur.theme}/${cur.surface} · viewer ${cur.role} · reg ${t('reg')}`;
 render();
}
seg('screens',[['clockin','Clock in'],['clockout','Clock out'],['geofence','Geofence'],['sync','Offline sync']],'screen');
seg('states',[['empty','empty'],['loading','loading'],['success','success'],['error','error'],['low-accuracy','low-acc'],['no-permission','no-perm'],['offline','offline'],['large-data','large-data'],['conflict','conflict']],'state');
seg('roles',['R01','R02','R03','R04','R05','R06','R07','R08','R09','R10','R11','R12','R13'].map(r=>[r,r]),'role');
seg('themes',[['light','Light'],['dark','Dark'],['glass','Glass'],['reduced','Reduced']],'theme');
seg('surfaces',[['desktop','Desk'],['tablet','Tablet'],['mobile','Mobile'],['kiosk','Kiosk']],'surface');
seg('langs',[['en','EN'],['sw','SW']],'lang');
sync();
