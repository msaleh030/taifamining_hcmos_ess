// Slice 9 · Governance (C20 · alerts) & ESS (E12 · E7) — flow logic (reuses kit)
// [Imported verbatim from claude.ai/design project c64829ec, 2026-07-14.
//  VERIFIED content-equivalent to the inline script of the Jul-5 self-contained
//  prototype design/prototypes/"HCMOS Governance & ESS.html": same CONTROLS
//  array, same state switches, same role gates (CTRL_VIEW R11/R12 etc.), same
//  seg() enumerations. The restructure (external gov-flow.js + gov-i18n.js) is
//  mechanical. Full byte content preserved below.]
function t(k){return window.T[cur.lang][k];}

const ic={
 shield:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
 check:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg>',
 x:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6 6 18M6 6l12 12"/></svg>',
 warn:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
 off:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 1l22 22M16.7 11.1A6 6 0 0 0 5 12M8.5 8.5A6 6 0 0 0 5 12M2 8.8A11 11 0 0 1 6 6M22 8.8a11 11 0 0 0-4.6-3.3M12 20h.01"/></svg>',
 wifi:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01"/></svg>',
 sync:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></svg>',
 lock:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="1"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
 users:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11"/></svg>',
 doc:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
 clock:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
 bell:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
 ticket:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M13 6v12"/></svg>',
 search:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
 plus:'<svg class="svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>'};

const initials=n=>n.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
let cur={screen:'controls',state:'populated',role:'R11',theme:'light',surface:'desktop',lang:'en'};
const CTRL_VIEW=['R11','R12'], ALERT_VIEW=['R05','R06','R07','R11','R12'];
const SUPPORT_AGENT=['R12','R07','R11'], POLICY_ADMIN=['R07','R11'];

function app(title,sub,netOff,bodyHTML){
 const net=netOff?`<span class="net off">${ic.off}${cur.lang==='en'?'Offline':'Nje ya mtandao'}</span>`
  :`<span class="net">${ic.wifi}${cur.lang==='en'?'Online':'Mtandaoni'}</span>`;
 return `<div class="app"><div class="topbar">${ic.shield}<div><div class="tt">${title}</div><div class="ts">${sub}</div></div>${net}</div>
  <div class="body">${bodyHTML}</div></div>`;
}
function center(icCls,icon,title,body,extra){return `<div class="center"><span class="ic ${icCls||''}">${icon}</span><h3>${title}</h3><p>${body}</p>${extra||''}</div>`;}
function skel(n){return '<div class="skelrow" style="width:100%;margin:9px 0"></div>'.repeat(n);}
function auditRow(txt){return `<div class="audit">${ic.shield}<span>${txt}</span><span class="h">#3f9a…d1</span></div>`;}
function lifePipe(stage){
 const labels=[t('lifeRaised'),t('lifeAck'),t('lifeProg'),t('lifeResolved'),t('lifeClosed')];
 return `<div class="pipe">${labels.map((l,i)=>{const s=i<stage?'done':i===stage?'active':'queued';const node=s==='done'?ic.check:`${i+1}`;
  return `<div class="pstep ${s}"><span class="pnode">${node}</span><span class="plbl">${l}</span></div>`;}).join('')}</div>`;
}

// ── Controls & Checker (C20) ──
const CONTROLS=[
 {key:'ctrlSod',d:'ctrlSodD',pass:false,checked:'1,204 actions',off:[['SOD-1','Issuer = approver on DISC-REG-0042','R06'],['SOD-2','Issuer = subject on LV-3187','R13']]},
 {key:'ctrlGps',d:'ctrlGpsD',pass:false,checked:'6,214 punches',off:[['ATT-8841','Clock-in · no GPS fix','Mwadui'],['ATT-8899','Clock-out · location denied','Nyanzaga'],['ATT-9002','No fix · offline unresolved','Dar Yard']]},
 {key:'ctrlLeaver',d:'ctrlLeaverD',pass:true,checked:'19 leavers',off:[]},
 {key:'ctrlChain',d:'ctrlChainD',pass:true,checked:'48,120 entries',off:[]}];
const ALL_CLEAR=CONTROLS.map(c=>({...c,pass:true,off:[]}));
function controlCard(c){
 const offHTML=c.off.length
  ?`<div class="offend">${c.off.map(([id,v,tag])=>`<div class="orow"><span class="oid">${id}</span><span class="ov">${v}</span><span class="otag">${tag}</span></div>`).join('')}</div>`
  :`<div class="note" style="color:var(--green)">${ic.check}<span>${t('offendNone')}</span></div>`;
 return `<div class="ctrl ${c.pass?'pass':'fail'}"><div class="ch"><span class="cih">${c.pass?ic.check:ic.warn}</span>
   <div style="flex:1"><div class="cn">${t(c.key)}</div><div class="cd">${t(c.d)}</div></div>
   <span class="cb ${c.pass?'pass':'fail'}"><span class="dot"></span>${c.pass?t('pass'):t('fail')}</span></div>
  <div style="font:600 10.5px var(--mono);color:var(--faint)">${c.checked} ${t('checked')}${c.off.length?` · ${c.off.length} ${t('offenders')}`:''}</div>
  ${offHTML}</div>`;
}
function runhead(){return `<div class="runhead">${ic.shield}<div style="flex:1"><div class="rt">${t('aud03')}</div><div class="rs">${t('runLast')} ${t('runLastVal')}</div></div><button class="btn b">${ic.sync} ${t('runNow')}</button></div>`;}
function controlsScreen(){
 if(!CTRL_VIEW.includes(cur.role)||cur.state==='no-permission')
  return app(t('controls'),t('controlsSub'),false,center('err',ic.lock,t('noPermControlsTitle'),t('noPermControlsBody'),`<div class="why">${t('noPermControlsWhy')} ${cur.role}</div>`));
 const off=cur.state==='offline', wrap=b=>app(t('controls'),t('controlsSub'),off,b);
 switch(cur.state){
  case 'empty': return wrap(center('',ic.shield,t('emptyControlsTitle'),t('emptyControlsBody'),`<button class="btn b">${ic.sync} ${t('runNow')}</button>`));
  case 'loading': return wrap(`${runhead()}<div class="banner info">${ic.sync}<div>${t('runningBody')}</div></div>${skel(5)}`);
  case 'error': return wrap(`<div class="banner err">${ic.warn}<div><b>${t('errTitle')}</b><br>${t('errBody')}</div></div><button class="btn p block">${ic.sync} ${t('retry')}</button>`);
  case 'success': return wrap(`<div class="seal"><span class="disc ok">${ic.check}</span><h3>${t('successControlsTitle')}</h3><p>${t('successControlsSub')}</p></div>${auditRow(t('ctrlNote'))}`);
  case 'all-clear': return wrap(`${runhead()}
   <div class="banner ok">${ic.check}<div><b>${t('allClearTitle')}</b> ${t('allClearBody')}</div></div>
   ${ALL_CLEAR.map(controlCard).join('')}
   <div class="note">${ic.shield}<span>${t('allClearNote')}</span></div>${auditRow(t('ctrlNote'))}`);
  case 'large-data': return wrap(`<div class="rmeta"><span class="scope">${ic.shield} ${t('largeControls')}</span><span class="cnt">${t('largeControlsMeta')}</span></div>${runhead()}${CONTROLS.map(controlCard).join('')}<div class="note">${ic.shield}<span>${t('ctrlNote')}</span></div>`);
  case 'offline': return wrap(`<div class="banner off">${ic.off}<div>${t('offControlsNote')}</div></div>${runhead()}${CONTROLS.map(controlCard).join('')}`);
  default: return wrap(`${runhead()}${CONTROLS.map(controlCard).join('')}<div class="note">${ic.shield}<span>${t('ctrlNote')}</span></div>`);
 }
}

// ── Expiry alerts (DOC-01) ──
const ALERTS=[
 {key:'aWorkPermit',who:'12 expatriates',st:'over',d:()=>t('overdue')+' · 3d'},
 {key:'aContract',who:'Amina Juma · TMC-03341',st:'due',d:()=>t('dueIn')+' 14d'},
 {key:'aMedical',who:'Mwadui crew · 8',st:'due',d:()=>t('dueIn')+' 28d'},
 {key:'aCert',who:'Grace Ndaki · TMC-03190',st:'cleared',d:()=>t('clearedLbl')}];
function alertRow(a){
 const i=a.st==='over'?ic.warn:a.st==='cleared'?ic.check:ic.bell;
 return `<div class="alertrow ${a.st}"><span class="ai">${i}</span><div style="flex:1"><div class="at">${t(a.key)}</div><div class="am">${a.who}</div></div><span class="aw">${a.d()}</span></div>`;
}
function alertConfig(){
 return `<div class="shead">${ic.bell} ${t('leadTitle')} <span style="font-weight:500;text-transform:none;letter-spacing:0;color:var(--faint)">· ${t('leadSub')}</span></div>
  <div class="leadset">${[[90,true],[60,false],[30,true],[7,true]].map(([d,on])=>`<span class="lead ${on?'on':''}">${d}d</span>`).join('')}</div>
  <div class="receipt"><div class="rr"><span class="k">${t('notifyTitle')} <span style="color:var(--faint)">· ${t('notifySub')}</span></span><span class="v">${t('notifyVal')}</span></div>
   <div class="rr"><span class="k">${t('repeatTitle')}</span><span class="v">${t('repeatVal')}</span></div></div>`;
}
function alertsScreen(){
 if(!ALERT_VIEW.includes(cur.role)||cur.state==='no-permission')
  return app(t('alerts'),t('alertsSub'),false,center('err',ic.lock,t('noPermAlertsTitle'),t('noPermAlertsBody'),`<div class="why">${t('noPermAlertsWhy')} ${cur.role}</div>`));
 const off=cur.state==='offline', wrap=b=>app(t('alerts'),t('alertsSub'),off,b);
 const list=`<div class="shead">${ic.clock} ${t('alertActive')}</div><div style="display:flex;flex-direction:column;gap:8px">${ALERTS.map(alertRow).join('')}</div>`;
 switch(cur.state){
  case 'empty': return wrap(center('',ic.bell,t('emptyAlertsTitle'),t('emptyAlertsBody')));
  case 'loading': return wrap(skel(6));
  case 'error': return wrap(`<div class="banner err">${ic.warn}<div><b>${t('errTitle')}</b><br>${t('errBody')}</div></div><button class="btn p block">${ic.sync} ${t('retry')}</button>`);
  case 'success': return wrap(`<div class="seal"><span class="disc ok">${ic.check}</span><h3>${t('successAlertTitle')}</h3><p>${t('successAlertSub')}</p></div>${alertConfig()}`);
  case 'large-data': return wrap(`${alertConfig()}${list}${ALERTS.map(alertRow).join('')}<div class="note">${ic.bell}<span>${t('alertNote')}</span></div>`);
  case 'offline': return wrap(`<div class="banner off">${ic.off}<div>${t('offAlertsNote')}</div></div>${alertConfig()}${list}`);
  default: return wrap(`${alertConfig()}${list}<div class="note">${ic.bell}<span>${t('alertNote')}</span></div>
   <div style="display:flex;gap:9px"><button class="btn g" style="flex:1">${t('clearBtn')}</button><button class="btn p" style="flex:2">${ic.check} ${t('setBtn')}</button></div>`);
 }
}

// ── Support tickets (E12) ──
function ticketCard(stage){
 const upd=[['Logged · IT support notified','22 Jun 09:10'],['Investigating payroll sync — ETA today','22 Jun 11:30']];
 return `<div class="reqcard"><div class="rq-h"><span class="av" style="background:var(--blue);width:34px;height:34px;border-radius:9px">${ic.ticket}</span>
   <div style="flex:1"><div class="nm">${t('tkSample')}</div><div class="mt">TK-1042 · Joseph Mlimani · TMC-04821</div></div>
   <span class="flag" style="background:rgba(0,148,212,.12);color:var(--blue);border-color:rgba(0,148,212,.3)">${t('tkChannel')}: ESS</span></div>
  <div class="rq-b" style="padding:12px 14px"><div style="font-size:12px;color:var(--muted);margin-bottom:12px">${t('tkDetail')}</div>
   ${lifePipe(stage)}
   <div class="shead" style="margin-top:14px">${ic.clock} ${t('tkNotify')}</div>
   <div class="custody">${upd.map(([e,m])=>`<div class="cevent"><div class="ce">${e}</div><div class="cm">${m}</div></div>`).join('')}</div></div></div>`;
}
function supportScreen(){
 const off=cur.state==='offline', wrap=b=>app(t('support'),t('supportSub'),off,b);
 switch(cur.state){
  case 'empty': return wrap(center('',ic.ticket,t('emptySupportTitle'),t('emptySupportBody'),`<button class="btn b">${ic.plus} ${t('raiseCta')}</button>`));
  case 'loading': return wrap(skel(6));
  case 'error': return wrap(`<div class="banner err">${ic.warn}<div><b>${t('errTitle')}</b><br>${t('errBody')}</div></div><button class="btn p block">${ic.sync} ${t('retry')}</button>`);
  case 'success': return wrap(`<div class="seal"><span class="disc ok">${ic.check}</span><h3>${t('successSupportTitle')}</h3><p>${t('successSupportSub')}</p></div>${ticketCard(0)}`);
  case 'large-data':{
   const agent=SUPPORT_AGENT.includes(cur.role);
   const all=[['TK-1042',t('tkSample'),'prog',true],['TK-1041','ID card reprint request','resolved',false],['TK-1039','Leave balance query','closed',true],['TK-1044','Cannot log in on new phone','open',false],['TK-1045','Payslip PDF blank','prog',false]];
   const rows=agent?all:all.filter(r=>r[3]);
   const badge=s=>s==='closed'?`<span class="astat returned"><span class="dot"></span>${t('tkClosed')}</span>`:s==='resolved'?`<span class="astat available"><span class="dot"></span>${t('tkResolved')}</span>`:`<span class="astat assigned"><span class="dot"></span>${t('tkOpen')}</span>`;
   const scope=agent?t('largeSupport'):t('ownSupportScope'), meta=agent?t('largeSupportMeta'):t('ownSupportMeta');
   const hint=agent?`<div class="vhint">${t('supportShown')}</div>`:'';
   const note=agent?'':`<div class="note">${ic.ticket}<span>${t('supportOwnNote')}</span></div>`;
   return wrap(`<div class="rmeta"><span class="scope">${ic.ticket} ${scope}</span><span class="cnt">${meta}</span></div>
    <div class="roster">${rows.map(([id,s,st])=>`<div class="rrow"><span class="av">${ic.ticket}</span><div style="flex:1"><div class="rn">${s}</div><div class="rs">${id}</div></div>${badge(st)}</div>`).join('')}${hint}</div>${note}`);
  }
  case 'offline': return wrap(`<div class="banner off">${ic.off}<div>${t('offSupportNote')}</div></div>${ticketCard(2)}`);
  default:{
   const agent=SUPPORT_AGENT.includes(cur.role);
   const actions=agent
    ?`<div style="display:flex;gap:9px"><button class="btn g" style="flex:1">${t('tkResolved')}</button><button class="btn p" style="flex:1">${ic.check} ${t('tkAdvance')}</button></div>`
    :`<button class="btn p block">${ic.plus} ${t('raiseCta')}</button>`;
   const note=agent?t('supportNote'):t('supportOwnTicketNote');
   return wrap(`${ticketCard(2)}<div class="note">${ic.bell}<span>${note}</span></div>${actions}`);
  }
 }
}

// ── Policy acknowledgement (E7) ──
function polCard(acked){
 return `<div class="polcard"><div class="plh"><div class="pltitle">${t('polTitle')}</div><div class="plver">${ic.doc} ${t('polVersion')}</div></div>
   <div class="polbody">${t('polRead')}<div class="pl m"></div><div class="pl"></div><div class="pl s"></div><div class="pl m"></div></div>
   <div class="ackbig"><span class="box ${acked?'on':''}">${acked?ic.check:''}</span>${acked?`${t('ackedLbl')} · ${t('ackedOn')}`:t('ackChk')}</div></div>`;
}
function policyScreen(){
 const off=cur.state==='offline', wrap=b=>app(t('policy'),t('policySub'),off,b);
 switch(cur.state){
  case 'empty': return wrap(center('',ic.doc,t('emptyPolicyTitle'),t('emptyPolicyBody')));
  case 'loading': return wrap(skel(6));
  case 'error': return wrap(`<div class="banner err">${ic.warn}<div><b>${t('errTitle')}</b><br>${t('errBody')}</div></div><button class="btn p block">${ic.sync} ${t('retry')}</button>`);
  case 'success': return wrap(`<div class="seal"><span class="disc ok">${ic.check}</span><h3>${t('successPolicyTitle')}</h3><p>${t('successPolicySub')}</p></div>${polCard(true)}${auditRow(t('trackedNote'))}`);
  case 'large-data':{
   if(!POLICY_ADMIN.includes(cur.role))
    return wrap(center('err',ic.lock,t('noPermPublishTitle'),t('noPermPublishBody'),`<div class="why">${t('noPermPublishWhy')} ${cur.role}</div>`));
   const staff=[['Joseph Mlimani','TMC-04821',true],['Grace Ndaki','TMC-03190',true],['Amina Juma','TMC-03341',false],['Peter Komba','TMC-02210',false],['Daniel Mwaky','TMC-01188',true]];
   const badge=a=>a?`<span class="astat available"><span class="dot"></span>${t('ackedLbl')}</span>`:`<span class="astat clearance"><span class="dot"></span>${t('ackPending')}</span>`;
   return wrap(`<div class="rmeta"><span class="scope">${ic.doc} ${t('outstanding')}</span><span class="cnt">${t('largePolicyMeta')}</span></div>
    <div class="trackbar"><div class="tp"><i style="width:81%"></i></div><span class="tv">1,014 / 1,246</span></div>
    <div class="roster">${staff.map(([n,no,a])=>`<div class="rrow"><span class="av">${initials(n)}</span><div style="flex:1"><div class="rn">${n}</div><div class="rs">${no}</div></div>${badge(a)}</div>`).join('')}</div>
    <div class="note">${ic.doc}<span>${t('trackedNote')}</span></div>
    <div style="display:flex;gap:9px"><button class="btn g" style="flex:1">${t('close')}</button><button class="btn p" style="flex:2">${ic.doc} ${t('publishBtn')}</button></div>`);
  }
  case 'offline': return wrap(`<div class="banner off">${ic.off}<div>${t('offPolicyNote')}</div></div>${polCard(false)}`);
  default: return wrap(`<div class="banner off">${ic.warn}<div>${t('reackBanner')}</div></div>${polCard(false)}
   <button class="btn p block">${ic.check} ${t('reackBtn')}</button>`);
 }
}

// ── render ──
function render(){
 const s=cur.screen;
 const html=s==='alerts'?alertsScreen():s==='support'?supportScreen():s==='policy'?policyScreen():controlsScreen();
 document.querySelector('.stage').innerHTML=`<div class="frame">${html}</div>`;
}
function seg(id,items,key){const el=document.getElementById(id);el.innerHTML=items.map(it=>{const v=Array.isArray(it)?it[0]:it,l=Array.isArray(it)?it[1]:it;return `<button data-v="${v}">${l}</button>`;}).join('');el.querySelectorAll('button').forEach(b=>b.onclick=()=>{cur[key]=b.getAttribute('data-v');sync();});}
const AC={controls:'AC-AUD-03 · controls & checker · UNI-06',alerts:'AC-DOC-01 · DA-1 lead times · DA-2 notified role',support:'AC-SUP-01..04 · lifecycle to closure',policy:'AC-POL-01..04 · read · acknowledge · re-acknowledge'};
function sync(){
 document.documentElement.setAttribute('data-theme',cur.theme);
 document.documentElement.setAttribute('data-surface',cur.surface);
 [['screens','screen'],['states','state'],['roles','role'],['themes','theme'],['surfaces','surface'],['langs','lang']].forEach(([id,k])=>document.querySelectorAll('#'+id+' button').forEach(b=>b.classList.toggle('on',b.getAttribute('data-v')===cur[k])));
 document.getElementById('acline').innerHTML=`Covers <b>${AC[cur.screen]}</b> · ${cur.theme}/${cur.surface} · viewer ${cur.role} · ${t('reg')}`;
 render();
}
seg('screens',[['controls','Controls · C20'],['alerts','Expiry alerts'],['support','Support · E12'],['policy','Policy · E7']],'screen');
seg('states',[['empty','empty'],['loading','loading'],['populated','populated'],['all-clear','all-clear'],['large-data','large-data'],['error','error'],['no-permission','no-perm'],['offline','offline'],['success','success']],'state');
seg('roles',['R01','R02','R03','R04','R05','R06','R07','R08','R09','R10','R11','R12','R13'].map(r=>[r,r]),'role');
seg('themes',[['light','Light'],['dark','Dark'],['glass','Glass'],['reduced','Reduced']],'theme');
seg('surfaces',[['desktop','Desk'],['tablet','Tablet'],['mobile','Mobile'],['kiosk','Kiosk']],'surface');
seg('langs',[['en','EN'],['sw','SW']],'lang');
sync();
