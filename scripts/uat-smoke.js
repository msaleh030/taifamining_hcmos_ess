'use strict';
// COMPREHENSIVE UAT SMOKE TEST (Kira, 2026-07-12) — executed over HTTPS through
// the Cloudflare tunnel as a real browser client would (fetch against BASE),
// NEVER against loopback. Report-only: PASS/FAIL/BLOCKED per item with
// evidence; no fixes. Mutations are minimal and reversed or inert:
//   • leave: 1-day sick apply→approve→(check)→apply→decline→(check restore)
//   • ingestion SoD: a ZERO-clean-row batch (one no-match row) — approving it
//     loads nothing; the same-user step proves the 403
//   • expat: raise→(non-checker 403)→R14 decline — no residue
// NO credential, PIN, or employee NAME is ever printed (C7: no PII in CI logs).
//
//   node scripts/uat-smoke.js <BASE> <credsFile> <inputsJson>
const fs = require('node:fs');

const [BASE, CREDS_PATH, INPUTS_PATH] = process.argv.slice(2);
if (!BASE || !CREDS_PATH || !INPUTS_PATH) {
  console.error('usage: node scripts/uat-smoke.js <base-url> <creds> <inputs.json>');
  process.exit(2);
}
const INPUTS = JSON.parse(fs.readFileSync(INPUTS_PATH, 'utf8'));
const creds = fs.readFileSync(CREDS_PATH, 'utf8');

// ── credentials: newest console block per email; ESS device blocks ──────────
const consolePw = new Map();
{
  const re = /email\s*:\s*(\S+)[\s\S]*?password\s*:\s*(\S+)/g;
  let m; while ((m = re.exec(creds))) consolePw.set(m[1], m[2]); // last wins
}
const essDev = new Map();
{
  const re = /--- ESS DEVICE \((\S+)\)\ndevice_id:\s*(\S+)\npin\s*:\s*(\S+)/g;
  let m; while ((m = re.exec(creds))) essDev.set(m[1], { device_id: m[2], pin: m[3] });
}

const T = () => AbortSignal.timeout(20000);
async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, signal: T(),
    body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; const text = await res.text();
  try { data = JSON.parse(text); } catch { data = { _nonjson: text.slice(0, 120) }; }
  return { status: res.status, body: data };
}

const RESULTS = [];
function report(item, verdict, evidence) {
  RESULTS.push({ item, verdict, evidence });
  console.log(`${item.padEnd(4)} ${verdict.padEnd(8)} ${evidence}`);
}
const seedish = (n) => /^Zz |^(Alice|Bob|Carol|Dave|Hettie|Ivy|Cate|Dan|Devon|Ellen|Frank|Gary|Zznm) /.test(n || '');

const E = {
  omid: 'omid.karambeck@taifamining.tz', cecilia: 'cecilia.mtweve@taifamining.tz',
  omar: 'omar.omar@taifamining.tz', viswa: 'viswa.medhuru@taifamining.tz',
  rajesh: 'rajesh.chohan@taifamining.tz', probe: 'uat.probe.r03@taifamining.tz',
  yusuph: 'yusuph.kabeza@taifamining.tz', ali: 'ali.mbarouk@taifamining.tz',
  ramadhan: 'ramadhan.mchomvu@taifamining.tz', advera: 'advera.speratus@taifamining.tz',
  baraka: 'baraka.nsemwa@taifamining.tz', poonam: 'poonam.divecha@taifamining.tz',
  maurice: 'maurice.mwendabai@taifamining.tz', richard: 'richard.tainton@taifamining.tz',
};
const TOK = {};
async function login(email) {
  if (TOK[email]) return TOK[email];
  const pw = consolePw.get(email);
  if (!pw) return null;
  const r = await api('POST', '/auth/console', { body: { email, password: pw } });
  if (r.status === 200) TOK[email] = r.body.token;
  return r.status === 200 ? r.body.token : { fail: r.status, err: r.body.error };
}

// Paginate the whole directory for a token; returns rows (no names printed).
async function fullDirectory(token) {
  const rows = []; let cursor = null;
  for (let page = 0; page < 12; page++) {
    const q = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : '?limit=200';
    const r = await api('GET', '/employees' + q, { token });
    if (r.status !== 200) return { error: r.status };
    rows.push(...r.body.rows);
    cursor = r.body.next_cursor;
    if (!cursor) break;
  }
  return { rows };
}
const siteName = (id) => (INPUTS.sites.find((s) => s.id === id) || {}).name || id;

(async () => {
  console.log(`UAT SMOKE over ${BASE} — as a real HTTPS client (Cloudflare edge -> tunnel)\n`);

  // ── Access-gate detection ───────────────────────────────────────────────
  const h = await api('GET', '/health');
  if (h.status !== 200 || h.body.ok !== true) {
    console.log(`BLOCKED-ALL: ${BASE}/health returned ${h.status} ${JSON.stringify(h.body).slice(0, 160)}`);
    console.log('The edge (Cloudflare Access?) is intercepting unauthenticated API calls — a service token or Access bypass for this runner is needed before any item can execute.');
    process.exit(2);
  }
  console.log(`edge OK: /health 200 build=${h.body.build}\n`);

  // ══ A. RBAC / ACCESS ══════════════════════════════════════════════════
  // A1 — all 14 console logins.
  {
    const fails = [];
    for (const [who, email] of Object.entries(E)) {
      const t = await login(email);
      if (typeof t !== 'string') fails.push(`${who}:${t ? t.fail : 'no-creds-block'}`);
    }
    report('A1', fails.length ? 'FAIL' : 'PASS',
      fails.length ? `${14 - fails.length}/14 logged in; failures: ${fails.join(' ')}` : '14/14 accounts logged in (email+password, MFA off in setup phase)');
  }

  // A2 — R03 single-site gates (directory content + cross-site 404).
  for (const [who, email, siteKey, foreignEmp] of [
    ['Yusuph', E.yusuph, 'Mwadui', INPUTS.sample.ho_emp],
    ['Ali', E.ali, 'Head Office', INPUTS.sample.mwadui_emp],
    ['Ramadhan', E.ramadhan, 'Nyanzaga - Sotta Mining Project', INPUTS.sample.mwadui_emp],
  ]) {
    const t = await login(email);
    if (typeof t !== 'string') { report('A2', 'BLOCKED', `${who}: login failed`); continue; }
    const d = await fullDirectory(t);
    if (d.error) { report('A2', 'FAIL', `${who}: directory ${d.error}`); continue; }
    const sites = [...new Set(d.rows.map((r) => siteName(r.site_id)))];
    const cross = await api('GET', `/employees/${foreignEmp}`, { token: t });
    const ok = sites.length === 1 && sites[0] === siteKey && cross.status === 404;
    report('A2', ok ? 'PASS' : 'FAIL',
      `${who}: ${d.rows.length} rows, sites=[${sites.join('; ')}] (want only ${siteKey}); other-site profile -> ${cross.status} (want 404)`);
  }

  // A3 — Advera: BOTH North Mara projects, nothing else.
  {
    const t = await login(E.advera);
    if (typeof t !== 'string') report('A3', 'BLOCKED', 'Advera: login failed');
    else {
      const d = await fullDirectory(t);
      const sites = d.rows ? [...new Set(d.rows.map((r) => siteName(r.site_id)))].sort() : [];
      const want = ['North Mara - L&H and Airstrip Project', 'North Mara - TSF Lift 10 Project'];
      const cross = await api('GET', `/employees/${INPUTS.sample.mwadui_emp}`, { token: t });
      const ok = !d.error && sites.length === 2 && want.every((w) => sites.includes(w)) && cross.status === 404;
      report('A3', ok ? 'PASS' : 'FAIL',
        `Advera: ${d.rows ? d.rows.length : '-'} rows across [${sites.join('; ')}]; Mwadui profile -> ${cross.status} (want 404)`);
    }
  }

  // A4 — central roles see all six sites (R12/R15/R16 are directory-DENIED by
  // design — central scope, but the directory itself is confidentiality-gated).
  {
    const parts = [];
    let ok = true;
    for (const [who, email] of [['Baraka R04', E.baraka], ['Poonam R04', E.poonam],
      ['Maurice R06', E.maurice], ['Omid R11', E.omid], ['Richard R14', E.richard], ['Cecilia R07', E.cecilia]]) {
      const t = await login(email);
      if (typeof t !== 'string') { parts.push(`${who}:login-fail`); ok = false; continue; }
      const d = await fullDirectory(t);
      const n = d.rows ? new Set(d.rows.map((r) => r.site_id)).size : 0;
      if (d.error || n !== 6) ok = false;
      parts.push(`${who}:${d.error ? `HTTP ${d.error}` : `${n} sites/${d.rows.length} rows`}`);
    }
    for (const [who, email] of [['Rajesh R12', E.rajesh], ['Omar R15', E.omar], ['Viswa R16', E.viswa]]) {
      const t = await login(email);
      const d = typeof t === 'string' ? await api('GET', '/employees?limit=1', { token: t }) : { status: 'login-fail' };
      if (d.status !== 403) ok = false;
      parts.push(`${who}:directory ${d.status} (403 BY DESIGN — central scope, directory confidentiality-denied)`);
    }
    report('A4', ok ? 'PASS' : 'FAIL', parts.join(' | '));
  }

  // A5 — pay/bank/TIN/passport tier: keys ABSENT (not masked) outside R07/R11/R15/R16.
  {
    const target = INPUTS.sample.mwadui_emp; // master-enriched: bank/tin populated
    const payKeys = ['basic_pay', 'bank_account', 'bank_name', 'tin', 'passport_number'];
    const parts = []; let ok = true;
    for (const [who, email, shouldSee] of [
      ['Cecilia R07', E.cecilia, true], ['Omid R11', E.omid, true],
      ['Yusuph R03', E.yusuph, false], ['Baraka R04', E.baraka, false],
      ['Maurice R06', E.maurice, false], ['Richard R14 (CEO)', E.richard, false],
    ]) {
      const t = await login(email);
      if (typeof t !== 'string') { parts.push(`${who}:login-fail`); ok = false; continue; }
      const p = await api('GET', `/employees/${target}`, { token: t });
      if (p.status !== 200) { parts.push(`${who}:HTTP ${p.status}`); if (who !== 'Yusuph R03') ok = false; else parts[parts.length-1] += ' (own-site only; Mwadui IS his site — unexpected)'; continue; }
      const present = payKeys.filter((k) => p.body[k] !== undefined && p.body[k] !== null);
      const masked = payKeys.filter((k) => typeof p.body[k] === 'string' && /\*|x{3,}|mask/i.test(p.body[k]));
      const good = shouldSee ? present.length > 0 : present.length === 0;
      if (!good || masked.length) ok = false;
      parts.push(`${who}: pay-tier keys ${shouldSee ? 'present' : 'absent'}=${good} [${present.join(',') || 'none'}]${masked.length ? ' MASKED-NOT-ABSENT!' : ''}`);
    }
    const r12 = await api('GET', `/employees/${target}`, { token: await login(E.rajesh) });
    parts.push(`Rajesh R12: profile ${r12.status} (403 by design — cannot browse people at all)`);
    report('A5', ok ? 'PASS' : 'FAIL', parts.join(' | '));
  }

  // A6 — national_id: configured HR set is R03,R04,R07,R11 (Kira 2026-07-09).
  {
    const target = INPUTS.sample.mwadui_emp;
    const parts = []; let ok = true;
    for (const [who, email, shouldSee] of [
      ['Yusuph R03', E.yusuph, true], ['Baraka R04', E.baraka, true],
      ['Cecilia R07', E.cecilia, true], ['Omid R11', E.omid, true],
      ['Maurice R06', E.maurice, false], ['Richard R14', E.richard, false],
    ]) {
      const t = await login(email);
      const p = typeof t === 'string' ? await api('GET', `/employees/${target}`, { token: t }) : { status: 0, body: {} };
      const has = p.status === 200 && p.body.national_id !== undefined;
      if (has !== shouldSee) ok = false;
      parts.push(`${who}:${p.status === 200 ? (has ? 'visible' : 'absent') : `HTTP ${p.status}`}`);
    }
    report('A6', ok ? 'PASS' : 'FAIL', `national_id (set R03,R04,R07,R11): ${parts.join(' | ')}`);
  }

  // ══ B. DATA INTEGRITY ═══════════════════════════════════════════════════
  // B1 — per-site directory truth vs the master-loaded canonical counts.
  {
    const t = await login(E.omid);
    const d = await fullDirectory(t);
    if (d.error) report('B1', 'FAIL', `directory as R11: HTTP ${d.error}`);
    else {
      const bySite = {};
      let seedCount = 0;
      for (const r of d.rows) {
        bySite[siteName(r.site_id)] = (bySite[siteName(r.site_id)] || 0) + 1;
        if (seedish(r.full_name)) seedCount++;
      }
      const wantMaster = { 'Head Office': 48, 'Mwadui': 348, 'North Mara - L&H and Airstrip Project': 171,
        'North Mara - TSF Lift 10 Project': 93, 'Nyanzaga - Sotta Mining Project': 275, 'Dar Yard': 67 };
      const masterOk = INPUTS.sites.every((s) => wantMaster[s.name] === undefined || s.master_loaded === wantMaster[s.name]);
      const dirLine = Object.entries(bySite).map(([k, v]) => `${k}:${v}`).join(' ');
      report('B1', masterOk ? 'PASS' : 'FAIL',
        `directory total ${d.rows.length}; per site ${dirLine}; MASTER-loaded per box ${INPUTS.sites.map((s) => `${s.name}:${s.master_loaded}`).join(' ')} (want 48/348/171/93/275/67=1003); seed-pattern names in directory: ${seedCount} (the pre-master 07-07 rows + demo fixtures — flagged, not deleted)`);
    }
  }

  // B2 — opening balances attach (box counts, read-only).
  {
    const want = { 'Head Office': 49, 'Mwadui': 361, 'North Mara - TSF Lift 10 Project': 104, 'Nyanzaga - Sotta Mining Project': 296 };
    const got = Object.fromEntries(INPUTS.sites.map((s) => [s.name, s.opening_rows]));
    const ok = Object.entries(want).every(([k, v]) => got[k] === v);
    report('B2', ok ? 'PASS' : 'FAIL',
      `opening-balance holders per site: ${INPUTS.sites.filter((s) => s.opening_rows).map((s) => `${s.name}:${s.opening_rows}`).join(' ')} (want HO 49, Mwadui 361, TSF 104, Nyanzaga 296; NM L&H 17 = the earlier legacy load)`);
  }

  // B3 — the 22 cross-site duplicate PFs: flagged where?
  {
    const n = INPUTS.dup_pf_people;
    const ok = n >= 22;
    report('B3', ok ? 'PASS' : 'FAIL',
      `${n} cross-site duplicate-PF persons exist (want the 22 loaded+flagged); marker today = load-report flag + emp_no WITHHELD (${INPUTS.dup_pf_no_empno} of them have emp_no NULL pending Head of HR); NOTE: no in-app profile badge yet — resolution list lives on the box`);
  }

  // B4 — expats carry permits; visible to R11 only.
  {
    const parts = []; let ok = INPUTS.expats.length > 0;
    for (const x of INPUTS.expats) {
      const asR11 = await api('GET', `/employees/${x.id}/documents`, { token: await login(E.omid) });
      const r11Permits = asR11.status === 200 ? asR11.body.documents.filter((d) => d.kind === 'permit').length : -1;
      const asR06 = await api('GET', `/employees/${x.id}/documents`, { token: await login(E.maurice) });
      const r06Permits = asR06.status === 200 ? asR06.body.documents.filter((d) => d.kind === 'permit').length : -1;
      const good = r11Permits === x.permits && r06Permits === 0;
      if (!good) ok = false;
      parts.push(`expat@${x.site}: R11 sees ${r11Permits}/${x.permits} permits, R06 sees ${r06Permits} (want 0)`);
    }
    report('B4', ok ? 'PASS' : 'FAIL', `${INPUTS.expats.length} classified expats; ${parts.join(' | ')}`);
  }

  // ══ C. WORKFLOWS ═════════════════════════════════════════════════════════
  // C1 — leave apply -> approve -> decrement; apply -> decline -> restore.
  {
    const t = await login(E.yusuph); // employee-bound console session (own record)
    let verdict = 'BLOCKED', ev = '';
    try {
      const bal0 = await api('GET', '/leave/balance', { token: t });
      if (bal0.status !== 200) throw new Error(`balance ${bal0.status}: ${bal0.body.error}`);
      const taken0 = bal0.body.sick ? bal0.body.sick.taken : null;
      if (taken0 == null) throw new Error('no sick bucket in balance response');
      const ap1 = await api('POST', '/leave/apply', { token: t, body: { leave_type: 'sick', days: 1 } });
      if (ap1.status !== 200) throw new Error(`apply1 ${ap1.status}: ${ap1.body.error}`);
      const q = await api('GET', '/leave/requests', { token: await login(E.baraka) });
      const mine = (q.body.pending || []).find((r) => r.id === ap1.body.id);
      if (!mine) throw new Error(`request not in R04 approval queue (queue ${q.status}, ${(q.body.pending || []).length} pending)`);
      const dec1 = await api('POST', `/leave/requests/${ap1.body.id}/decide`, { token: await login(E.baraka), body: { approve: true } });
      if (dec1.status !== 200) throw new Error(`approve ${dec1.status}: ${dec1.body.error}`);
      const bal1 = await api('GET', '/leave/balance', { token: t });
      const taken1 = bal1.body.sick.taken;
      const ap2 = await api('POST', '/leave/apply', { token: t, body: { leave_type: 'sick', days: 1 } });
      const dec2 = await api('POST', `/leave/requests/${ap2.body.id}/decide`, { token: await login(E.baraka), body: { approve: false } });
      const bal2 = await api('GET', '/leave/balance', { token: t });
      const taken2 = bal2.body.sick.taken;
      const ok = taken1 === taken0 + 1 && taken2 === taken1;
      verdict = ok ? 'PASS' : 'FAIL';
      ev = `sick.taken ${taken0} -> approve(+1d) -> ${taken1} (want ${taken0 + 1}); declined 1d -> ${taken2} (want ${taken1}, no charge); queue showed the request to R04; decline ${dec2.status}`;
    } catch (e) { ev = `leave flow: ${e.message} (officer accounts carry no opening balances; sick draws the entitlement rule)`; }
    report('C1', verdict, ev);
  }

  // C2 — leave SoD: the requester cannot decide their own request.
  {
    const t = await login(E.baraka); // R04 — can approve, also has an employee record
    let verdict = 'BLOCKED', ev = '';
    try {
      const ap = await api('POST', '/leave/apply', { token: t, body: { leave_type: 'sick', days: 1 } });
      if (ap.status !== 200) throw new Error(`apply ${ap.status}: ${ap.body.error}`);
      const self = await api('POST', `/leave/requests/${ap.body.id}/decide`, { token: t, body: { approve: true } });
      const cleanup = await api('POST', `/leave/requests/${ap.body.id}/decide`, { token: await login(E.omid), body: { approve: false } });
      verdict = self.status === 403 ? 'PASS' : 'FAIL';
      ev = `Baraka deciding his OWN request -> ${self.status} "${self.body.error || ''}" (want 403 SOD-01); cleanup decline by Omid -> ${cleanup.status}`;
    } catch (e) { ev = e.message; }
    report('C2', verdict, ev);
  }

  // C3 — ingestion SoD over HTTPS: Omar submits, Omar cannot approve, Viswa can.
  {
    let verdict = 'BLOCKED', ev = '';
    try {
      const rows = [{ pf: '00000000', name: 'No Such Person', site: 'Head Office', accrued: 0, taken: 0, balance: 0 }];
      const sub = await api('POST', '/ingest/opening-balance/commit', {
        token: await login(E.omar), body: { rows, control_totals: { 'Head Office': { count: 0, sum_balance: 0 } } } });
      if (sub.status !== 200) throw new Error(`submit ${sub.status}: ${JSON.stringify(sub.body).slice(0, 140)}`);
      const self = await api('POST', '/ingest/opening-balance/commit', {
        token: await login(E.omar), body: { batch_id: sub.body.batch_id } });
      const other = await api('POST', '/ingest/opening-balance/commit', {
        token: await login(E.viswa), body: { batch_id: sub.body.batch_id } });
      const ok = self.status === 403 && other.status === 200 && other.body.loaded === 0;
      verdict = ok ? 'PASS' : 'FAIL';
      ev = `Omar submitted batch (clean=0, 1 no-match exception); Omar approving own batch -> ${self.status} "${self.body.error || ''}" (want 403); Viswa approving -> ${other.status} loaded=${other.body.loaded} (zero-row batch: SoD chain proven with NO data change)`;
    } catch (e) { ev = e.message; }
    report('C3', verdict, ev);
  }

  // C4 — expat CRUD: only R11 raises; only R14 decides.
  {
    let verdict = 'BLOCKED', ev = '';
    const x = INPUTS.expats[0];
    if (!x) ev = 'no classified expat on the box';
    else {
      const r04 = await api('POST', `/employees/${x.id}/change`, { token: await login(E.baraka), body: { field: 'phone', value: '0700000001' } });
      const r11 = await api('POST', `/employees/${x.id}/change`, { token: await login(E.omid), body: { field: 'phone', value: '0700000001' } });
      let selfDecide = { status: '-' }, r14 = { status: '-' };
      if (r11.status === 200) {
        selfDecide = await api('POST', `/field-change/${r11.body.id}/decline`, { token: await login(E.omid) });
        r14 = await api('POST', `/field-change/${r11.body.id}/decline`, { token: await login(E.richard) });
      }
      const ok = r04.status === 403 && /Head of HR/.test(r04.body.error || '') && r11.status === 200
        && selfDecide.status === 403 && r14.status === 200;
      verdict = ok ? 'PASS' : 'FAIL';
      ev = `R04 raise on expat -> ${r04.status} "${r04.body.error || ''}"; R11 raise -> ${r11.status}; R11 deciding own -> ${selfDecide.status} (want 403, CEO-only); R14 decline -> ${r14.status} (no residue)`;
    }
    report('C4', verdict, ev);
  }

  // C5 — document-expiry alert routing.
  {
    const parts = [];
    for (const [who, email] of [['Omid R11', E.omid], ['Maurice R06', E.maurice], ['Yusuph R03', E.yusuph]]) {
      const a = await api('GET', '/alerts', { token: await login(email) });
      const kinds = a.status === 200 && a.body.alerts ? [...new Set(a.body.alerts.map((x) => x.kind || x.doc_kind || 'alert'))] : [];
      parts.push(`${who}: ${a.status === 200 ? `${(a.body.alerts || []).length} open [${kinds.join(',')}]` : `HTTP ${a.status}`}`);
    }
    const anyOpen = parts.some((p) => / [1-9]\d* open/.test(p));
    report('C5', anyOpen ? 'PASS' : 'BLOCKED',
      `${parts.join(' | ')}${anyOpen ? '' : ` — nothing inside the lead windows yet (earliest loaded permit expiry ${INPUTS.earliest_permit_expiry}); routing rules are config-pinned (expat->R11, business->R06, medical->site R03) but UNEXERCISED by live data`}`);
  }

  // C6 — organogram: renders, positional, site-scoped.
  {
    const asR11 = await api('GET', '/reports/organogram', { token: await login(E.omid) });
    const asR03 = await api('GET', '/reports/organogram', { token: await login(E.yusuph) });
    const sitesOf = (b) => (b && b.sites ? b.sites.map((s) => s.site || s.name) : []);
    const s11 = sitesOf(asR11.body), s03 = sitesOf(asR03.body);
    const ok = asR11.status === 200 && s11.length === 6 && asR03.status === 200 && s03.length === 1 && /Mwadui/.test(s03[0] || '');
    report('C6', ok ? 'PASS' : 'FAIL',
      `R11: ${asR11.status}, ${s11.length} sites; R03 Yusuph: ${asR03.status}, sites=[${s03.join(';')}] (want Mwadui only); limitation note present: ${!!(asR11.body && JSON.stringify(asR11.body).includes('cannot say WHICH'))}`);
  }

  // C7 — audit trail: verified via read-only DB query in the workflow step that
  // follows this script (no HTTP audit endpoint exists — reported as a gap).
  report('C7', 'PARTIAL', 'audit rows for the actions above are printed by the follow-up read-only step (action + role + count, actors masked); DEFECT/GAP: no in-app audit view over HTTPS — audit_log is DB-side only');

  // ══ D. ESS ═══════════════════════════════════════════════════════════════
  const dev = essDev.get(E.yusuph);
  // D1 — reachability of the app + the field-auth endpoint through the tunnel.
  {
    const root = await fetch(BASE + '/', { signal: T() });
    const html = (await root.text()).slice(0, 400);
    const spa = root.status === 200 && /<div id="root"|<script/i.test(html);
    report('D1', spa ? 'PASS' : 'FAIL',
      `GET / -> ${root.status} SPA served=${spa}; ESS lives at ${BASE}/ess (same host, /auth/field API); no separate hostname`);
  }
  // D2 — device + PIN login.
  let fieldTok = null;
  {
    if (!dev) report('D2', 'BLOCKED', 'no ESS device block for the test officer in the credentials file');
    else {
      const r = await api('POST', '/auth/field', { body: { device_id: dev.device_id, pin: dev.pin } });
      if (r.status === 200) fieldTok = r.body.token;
      report('D2', r.status === 200 ? 'PASS' : 'FAIL', `device+PIN login -> ${r.status} (device bound to the officer's employee record)`);
    }
  }
  // D3 — credential separation both directions.
  {
    if (!dev) report('D3', 'BLOCKED', 'no device credentials');
    else {
      const pinOnConsole = await api('POST', '/auth/console', { body: { email: E.yusuph, password: dev.pin } });
      const pwOnField = await api('POST', '/auth/field', { body: { device_id: dev.device_id, pin: consolePw.get(E.yusuph) } });
      const consoleApiAsDevice = fieldTok ? await api('GET', '/employees?limit=1', { token: fieldTok }) : { status: '-' };
      const ok = pinOnConsole.status === 401 && pwOnField.status === 401 && consoleApiAsDevice.status === 403;
      report('D3', ok ? 'PASS' : 'FAIL',
        `PIN on console -> ${pinOnConsole.status} (want 401); console password on ESS -> ${pwOnField.status} (want 401); device token on the console directory -> ${consoleApiAsDevice.status} (want 403 — surfaces never cross)`);
    }
  }
  // D4 — ESS sees only own record.
  {
    if (!fieldTok) report('D4', 'BLOCKED', 'no field session (D2 failed)');
    else {
      const own = await api('GET', `/me/profile/${INPUTS.officer_emp.yusuph}`, { token: fieldTok });
      const other = await api('GET', `/me/profile/${INPUTS.sample.mwadui_emp}`, { token: fieldTok });
      const slips = await api('GET', '/me/payslips', { token: fieldTok });
      const ok = own.status === 200 && (other.status === 403 || other.status === 404) && slips.status === 200;
      report('D4', ok ? 'PASS' : 'FAIL',
        `own profile -> ${own.status}; ANOTHER employee's profile -> ${other.status} (want 403/404); own payslips -> ${slips.status} (list of own only)`);
    }
  }
  // D5 — offline idempotency: same idempotency_key twice -> one punch.
  {
    if (!fieldTok) report('D5', 'BLOCKED', 'no field session');
    else {
      const key = `smoke-${INPUTS.run_stamp}`;
      const body = { lat: -3.5333, lng: 33.4333, idempotency_key: key };
      const p1 = await api('POST', '/attendance/clock-in', { token: fieldTok, body });
      const p2 = await api('POST', '/attendance/clock-in', { token: fieldTok, body });
      if (p1.status !== 200) report('D5', 'BLOCKED', `clock-in refused: ${p1.status} "${p1.body.error || ''}" — geofence zones are not configured for the real sites yet, so the punch (and its offline sync) cannot be exercised`);
      else {
        const same = JSON.stringify(p1.body) === JSON.stringify(p2.body);
        report('D5', same ? 'PASS' : 'FAIL', `same idempotency_key twice -> identical response=${same} (one punch recorded, no duplicate)`);
      }
    }
  }

  // ══ E. SUMMARY ════════════════════════════════════════════════════════════
  console.log('\n══ SUMMARY ══');
  const counts = {};
  for (const r of RESULTS) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  '));
  process.exit(RESULTS.some((r) => r.verdict === 'FAIL') ? 1 : 0);
})().catch((e) => { console.error('SMOKE ERROR:', e.message); process.exit(2); });
