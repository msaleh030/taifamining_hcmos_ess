// Bilingual engine — English ⇄ Kiswahili, INDEPENDENT per platform.
// The console (HCMOS) and the ESS device translate separately: a node is translated
// using the language of the platform it belongs to (.ess subtree = ESS, else = HCMOS).
// A DOM layer + MutationObserver keep it applied across React re-renders, toasts & dialogs.
(function(){
  const KEY = 'hcwos.lang';        // legacy single key (migration)
  const SKEY = 'hcwos.lang.';      // per-scope: hcwos.lang.hcmos / hcwos.lang.ess
  const langs = {
    hcmos: localStorage.getItem(SKEY+'hcmos') || localStorage.getItem(KEY) || 'en',
    ess:   localStorage.getItem(SKEY+'ess')   || localStorage.getItem(KEY) || 'en',
  };
  const listeners = new Set();

  // ── EN → SW dictionary (visible UI chrome, labels, buttons, messages, ESS) ──
  const DICT = {
    // modules / nav
    'Workforce Overview':'Muhtasari wa Wafanyakazi', 'Employees':'Wafanyakazi',
    'Leave & Attendance':'Likizo na Mahudhurio', 'Performance':'Utendaji',
    'Performance & Recruitment':'Utendaji na Uajiri', 'Health, Safety, Environment & Quality':'Afya, Usalama, Mazingira na Ubora',
    'Training':'Mafunzo', 'Training & Competency':'Mafunzo na Umahiri', 'Grievances':'Malalamiko',
    'Approvals':'Idhini', 'Payroll':'Mishahara', 'Reports':'Ripoti', 'Reports & Analytics':'Ripoti na Uchambuzi',
    'Exact Integration':'Muunganisho wa Exact', 'Security & Access':'Usalama na Ufikiaji',
    'Mobile app':'Programu ya Simu', 'ESS (mobile)':'ESS (simu)', 'Employee Self-Service':'Huduma Binafsi ya Mfanyakazi',
    'KPI Scorecard':'Kadi ya Viashiria', 'Organization & Settings':'Shirika na Mipangilio',
    'Workspace':'Eneo kazi', 'Core HR & Records':'HR Msingi na Kumbukumbu', 'Reports & Insights':'Ripoti na Maarifa',
    'Payroll & Finance':'Mishahara na Fedha', 'Administration':'Utawala', 'Health, Safety & Quality':'Afya, Usalama na Ubora',
    'All sites':'Maeneo yote', 'Help & support':'Msaada', 'My ID card':'Kadi yangu ya kitambulisho', 'ID card':'Kadi ya kitambulisho',
    // KPI / labels
    'Total headcount':'Idadi ya wafanyakazi', 'On leave today':'Wapo likizo leo', 'Monthly wage bill':'Mshahara wa mwezi',
    'Leave liability':'Deni la likizo', 'Days since LTI':'Siku tangu LTI', 'Clocked in today':'Waliosaini leo',
    'Pending approvals':'Idhini zinazosubiri', 'Records (filtered)':'Kumbukumbu (zilizochujwa)', 'Digital files':'Faili za kidijitali',
    'Compliance flags':'Alama za uzingatiaji', 'Expatriates':'Wageni', 'On leave':'Wapo likizo',
    'Leave balance':'Salio la likizo', 'Rotation':'Mzunguko', 'Available':'Inapatikana', 'Monetised':'Thamani ya fedha',
    'Your access':'Ufikiaji wako', 'Report templates':'Violezo vya ripoti', 'Sites reporting':'Maeneo yanayoripoti',
    'Active accounts':'Akaunti hai', 'Roles configured':'Majukumu yaliyowekwa', 'Audit events logged':'Matukio yaliyorekodiwa',
    'Cycle completion':'Ukamilishaji wa mzunguko', 'Avg rating':'Wastani wa daraja', 'Acknowledged':'Imethibitishwa',
    'Clocked in':'Umesaini kuingia', 'Not clocked in':'Hujasaini kuingia', 'Medicals valid':'Vipimo halali',
    // buttons / common / popups
    'Approve':'Idhinisha', 'Decline':'Kataa', 'Reject':'Kataa', 'Sign in':'Ingia', 'Sign out':'Toka',
    'Read-only':'Kusoma tu', 'New joiner':'Mwajiriwa mpya', 'Transfer':'Hamisha', 'Share doc':'Shiriki nyaraka',
    'Cancel':'Ghairi', 'Dismiss':'Ondoa', 'Export log':'Hamisha kumbukumbu', 'Export':'Hamisha', 'Verify integrity':'Thibitisha uadilifu',
    'Submit request':'Wasilisha ombi', 'Apply leave':'Omba likizo', 'Apply for leave':'Omba likizo',
    'My documents':'Nyaraka zangu', 'My payslips':'Risiti zangu za malipo', 'Payslip':'Risiti ya malipo',
    'Policies':'Sera', 'Notifications':'Arifa', 'Acknowledge':'Thibitisha', 'Acknowledge review':'Thibitisha tathmini',
    'Sign & acknowledge':'Saini na thibitisha', 'Clock in':'Saini kuingia', 'Clock out':'Saini kutoka',
    'Clock in now':'Saini kuingia sasa', 'Upload a document':'Pakia nyaraka', 'New requisition':'Ombi jipya la ajira',
    'Assign review':'Kabidhi tathmini', 'Publish to ESS':'Chapisha kwa ESS', 'Record transfer':'Rekodi uhamisho',
    'Send':'Tuma', 'Preview':'Hakiki', 'Open':'Fungua', 'Schedule report':'Panga ratiba ya ripoti',
    'Nominate':'Teua', 'Mark all read':'Weka zote zimesomwa', 'Not now':'Si sasa', 'Accept & apply':'Kubali na uombe',
    'Log grievance':'Sajili lalamiko', 'Log incident':'Sajili tukio',
    'Save':'Hifadhi', 'Open case':'Fungua kesi', 'Open investigation':'Fungua uchunguzi',
    'Route for approval':'Peleka kwa idhini', 'Awaiting your approval':'Inasubiri idhini yako',
    'Confirm':'Thibitisha', 'Suspend':'Simamisha', 'Reinstate':'Rejesha', 'Resolve':'Tatua', 'Close':'Funga',
    'Reopen':'Fungua tena', 'Confirm resolved':'Thibitisha kutatuliwa', 'Submit ticket':'Wasilisha tiketi',
    'Reset':'Weka upya', 'Assign':'Kabidhi', 'Work':'Shughulikia', 'Acknowledge ':'Thibitisha',
    'Add photo':'Ongeza picha', 'Confirm my details':'Thibitisha taarifa zangu', 'Update my profile':'Sasisha wasifu wangu',
    'New request':'Ombi jipya', 'Email support':'Barua pepe ya msaada', 'Call 24/7 support':'Piga simu msaada 24/7',
    'Flip to QR':'Geuza kwa QR', 'Show front':'Onyesha mbele',
    // ESS screens / phrases
    'Home':'Nyumbani', 'Clock':'Saa', 'Leave':'Likizo', 'Docs':'Nyaraka', 'Profile':'Wasifu',
    'My overview':'Muhtasari wangu', 'Approvals inbox':'Sanduku la idhini', 'Awaiting you':'Yanakusubiri',
    'Recent activity':'Shughuli za hivi karibuni', 'My requests':'Maombi yangu', 'My training':'Mafunzo yangu',
    'My training tickets':'Tiketi zangu za mafunzo', 'New training request':'Ombi jipya la mafunzo',
    'My activity history':'Historia ya shughuli zangu', 'My KPIs':'Viashiria vyangu', 'Help':'Msaada', 'Support':'Msaada',
    'Leave type':'Aina ya likizo', 'LEAVE TYPE':'AINA YA LIKIZO', 'COURSE':'KOZI', 'JUSTIFICATION':'SABABU',
    'Suggested leave from HR':'Likizo iliyopendekezwa na HR', 'New performance review from HR':'Tathmini mpya ya utendaji kutoka HR',
    'Documents & payslips':'Nyaraka na risiti za malipo',
    'Shared by HR':'Imeshirikiwa na HR', 'Uploaded by me':'Nimepakia', 'Earnings':'Mapato', 'Deductions':'Makato',
    'Gross':'Jumla', 'Net pay':'Malipo halisi', 'Total deductions':'Jumla ya makato', 'Key points':'Mambo muhimu',
    'Read & sign':'Soma na usaini', 'Signed':'Imesainiwa',
    'No reviews published yet.':'Hakuna tathmini zilizochapishwa bado.',
    'Complete your profile':'Kamilisha wasifu wako', 'Complete your profile first':'Kamilisha wasifu wako kwanza',
    'My ID':'Kitambulisho changu', 'Help & support':'Msaada',
    // misc headers
    'Reports to':'Anaripoti kwa', 'Status':'Hali', 'Since':'Tangu', 'Today':'Leo', 'Next payslip':'Risiti ijayo',
    'On shift':'Kazini', 'Off shift':'Nje ya kazi', 'Work email':'Barua pepe ya kazi', 'PIN':'PIN',
    'Active':'Hai', 'Suspended':'Imesimamishwa', 'Pending':'Inasubiri',
    'employees':'wafanyakazi', 'sites':'maeneo', 'roles':'majukumu',
  };

  const orig = new WeakMap();   // text node -> original (English) nodeValue
  let observer = null, busy = false;

  function scopeOf(node){ let el = node.parentElement || node.parentNode;
    while(el){ if(el.classList && el.classList.contains('ess')) return 'ess'; el=el.parentElement; }
    return 'hcmos'; }

  function tNode(node){
    if(node.nodeType===3){
      const baseEn = orig.has(node) ? orig.get(node) : node.nodeValue;
      const key = baseEn.trim();
      const target = langs[scopeOf(node)];
      if(target==='sw' && DICT[key]){
        if(!orig.has(node)) orig.set(node, node.nodeValue);
        const tr = orig.get(node).replace(key, DICT[key]);
        if(node.nodeValue!==tr) node.nodeValue = tr;
      } else if(orig.has(node) && node.nodeValue!==orig.get(node)){
        node.nodeValue = orig.get(node);   // revert to English
      }
    } else if(node.nodeType===1 && !/^(SCRIPT|STYLE|SVG|PATH)$/.test(node.tagName)){
      if(node.getAttribute){
        const ph = node.getAttribute('placeholder');
        if(ph!=null){ if(node.__phEn==null) node.__phEn=ph; const key=node.__phEn.trim(); const target=langs[scopeOf(node)];
          node.setAttribute('placeholder', (target==='sw' && DICT[key]) ? node.__phEn.replace(key,DICT[key]) : node.__phEn); }
      }
      node.childNodes.forEach(tNode);
    }
  }
  function applyAll(){ busy=true;
    tNode(document.getElementById('root') || document.body);
    document.querySelectorAll('.toast-wrap, [role=dialog]').forEach(tNode);
    busy=false; }

  function ensureObserver(){
    if(observer) return;
    observer = new MutationObserver(muts=>{
      if(busy) return;
      if(langs.hcmos==='en' && langs.ess==='en') return;
      busy=true;
      for(const m of muts){ if(m.type==='characterData') tNode(m.target); else m.addedNodes.forEach(tNode); }
      busy=false;
    });
    observer.observe(document.body, { subtree:true, childList:true, characterData:true });
  }

  function setLang(scope, l){
    scope = (scope==='ess') ? 'ess' : 'hcmos';
    if(langs[scope]===l) return;
    langs[scope]=l; localStorage.setItem(SKEY+scope, l);
    ensureObserver(); applyAll();
    listeners.forEach(fn=>fn(scope,l));
  }
  function init(){ ensureObserver(); if(langs.hcmos==='sw' || langs.ess==='sw') applyAll(); }
  if(document.readyState==='complete' || document.readyState==='interactive') setTimeout(init, 400);
  else window.addEventListener('DOMContentLoaded', ()=>setTimeout(init,400));

  window.HLang = {
    get:(scope)=>langs[(scope==='ess')?'ess':'hcmos'], set:setLang,
    subscribe:(fn)=>{ listeners.add(fn); return ()=>listeners.delete(fn); },
    t:(s,scope)=> langs[(scope==='ess')?'ess':'hcmos']==='sw' ? (DICT[s]||s) : s,
  };
  window.useLang = function(scope){
    const [,f] = React.useReducer(x=>x+1,0);
    React.useEffect(()=>HLang.subscribe(f),[]);
    return langs[(scope==='ess')?'ess':'hcmos'];
  };

  // Segmented EN | KISW switch — pass scope="hcmos" (default) or scope="ess"
  window.LangSwitch = function({ dark=false, scope='hcmos' }){
    const cur = useLang(scope);
    const base = { border:'none', cursor:'pointer', fontWeight:700, fontSize:11.5, padding:'5px 10px', borderRadius:7, lineHeight:1 };
    const wrapBg = dark ? 'rgba(255,255,255,.15)' : 'var(--surface-2)';
    return <div title="Language / Lugha" style={{display:'inline-flex',gap:2,padding:2,borderRadius:9,background:wrapBg}}>
      {[['en','ENG'],['sw','KISW']].map(([v,l])=>{
        const on = cur===v;
        return <button key={v} onClick={()=>HLang.set(scope,v)} style={{...base,
          background:on?(dark?'#fff':'var(--accent)'):'transparent',
          color:on?(dark?'#15191D':'#fff'):(dark?'#fff':'var(--muted)')}}>{l}</button>;
      })}
    </div>;
  };
})();
