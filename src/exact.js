'use strict';
// Slice 8 — Exact payroll ingestion. Uploads are validated against the versioned
// column contract (exact_column, seeded from the registry v1.2 appendix), staged,
// matched (EMPLOYEE ID → employee), and published atomically. Registry v1.3/v1.4
// confirmed match.key=legacy_id, netpay.source=col AS, and the daily-rate base
// (overtime + Rotation/Night CONFIRMED excluded). The only remaining [TBC]:
//   - exact.reconciliation     (AC-EXACT-07, gated until a real populated period)
const crypto = require('node:crypto');
const db = require('./db');
const cfg = require('./config');
const { HttpError } = require('./errors');

// ── Minimal CSV parser (pure JS) → 2D array of trimmed-per-cell strings ─────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* swallow CR */ }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const gridHash = (grid) => crypto.createHash('sha256').update(JSON.stringify(grid)).digest('hex');

async function loadContract(client, version) {
  const r = await client.query(
    'SELECT position, section, header, pinned FROM exact_column WHERE version=$1 ORDER BY position', [version]);
  return r.rows;
}

// ── AC-EXACT-01/02/03: validate an uploaded grid against the contract ───────
async function validateLayout(client, companyId, grid) {
  const version    = await cfg.getConfig(companyId, 'exact.contract.version', 'v1.2', client);
  const headerRow  = await cfg.getInt(companyId, 'exact.header_row', 7, client);   // 1-based
  const sectionRow = await cfg.getInt(companyId, 'exact.section_row', 6, client);  // 1-based
  const contract   = await loadContract(client, version);
  if (contract.length === 0) throw new HttpError(409, `no column contract for version ${version}`);

  const errors = [];
  if (grid.length < headerRow) errors.push(`file has no header row at row ${headerRow}`);
  if (!grid[sectionRow - 1]) errors.push(`missing section-label row ${sectionRow}`);

  const header = grid[headerRow - 1] || [];
  if (header.length !== contract.length) {
    errors.push(`expected ${contract.length} columns, got ${header.length}`);
  }
  for (const col of contract) {
    if (!col.pinned) continue; // only confirmed headers are enforced
    const actual = (header[col.position] || '').trim();
    if (actual.toUpperCase() !== col.header.toUpperCase()) {
      errors.push(`col ${col.position}: expected header "${col.header}", got "${actual}"`);
    }
  }
  if (errors.length) throw new HttpError(422, 'exact layout invalid', { errors });

  return { version, headerRow, contract, dataRows: grid.slice(headerRow) };
}

// Normalise a declared control-totals object to the three numeric columns (or
// null when not supplied). Accepts total_pay / total_deduction / net.
function controlCols(ct) {
  if (!ct || typeof ct !== 'object') return { tp: null, td: null, net: null };
  const opt = (v) => (v == null || v === '' ? null : num(v));
  return { tp: opt(ct.gross), td: opt(ct.total_deduction), net: opt(ct.net) }; // v1.5: gross
}

// ── AC-EXACT-06: stage a load (idempotent by PERIOD + file hash) ────────────
async function stage(session, { period, filename, grid, controlTotals }) {
  if (!Array.isArray(grid)) throw new HttpError(400, 'grid required');
  // bughunt-B #7: dedupe is per (period, content). Fixed-salary tenants upload a
  // byte-identical grid every month — a content-only hash silently deduped the
  // NEW period to the OLD batch and a whole month of postings never staged.
  // Folding the period into the stored hash keeps UNIQUE (company_id, file_hash)
  // satisfied without a migration: same period+grid still dedupes; new period
  // stages fresh.
  const fileHash = crypto.createHash('sha256').update(`${period || ''}|${gridHash(grid)}`).digest('hex');
  const ct = controlCols(controlTotals);

  return db.withTenant(session.company_id, async (c) => {
    const { version, dataRows } = await validateLayout(c, session.company_id, grid);

    const existing = await c.query(
      'SELECT id, status, row_count FROM exact_batch WHERE file_hash=$1', [fileHash]);
    if (existing.rows[0]) {
      const b = existing.rows[0];
      return { batch_id: b.id, deduped: true, row_count: b.row_count, status: b.status };
    }

    const batch = (await c.query(
      `INSERT INTO exact_batch (company_id, period, filename, file_hash, version, status, row_count,
                                control_total_pay, control_total_deduction, control_net)
       VALUES ($1,$2,$3,$4,$5,'staged',$6,$7,$8,$9) RETURNING id`,
      [session.company_id, period || null, filename || null, fileHash, version, dataRows.length,
       ct.tp, ct.td, ct.net])).rows[0];

    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i];
      await c.query(
        `INSERT INTO exact_row (company_id, batch_id, row_no, employee_id_raw, full_name, cells, match_status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [session.company_id, batch.id, i + 1, (cells[0] || '').trim(), (cells[1] || '').trim(), JSON.stringify(cells)]);
    }
    return { batch_id: batch.id, deduped: false, row_count: dataRows.length, status: 'staged' };
  });
}

// ── AC-EXACT-04/05: match EMPLOYEE ID → employee; report the unmatched ──────
// The mapping (EMPLOYEE ID == HCMOS number or legacy_id) is [TBC]: BLOCKS until set.
async function match(session, batchId) {
  const key = await cfg.getRequired(session.company_id, 'exact.match.key'); // BLOCK if PENDING
  const column = key === 'hcmos' ? 'emp_no' : key === 'legacy_id' ? 'legacy_id' : null;
  if (!column) throw new HttpError(409, `exact.match.key must be 'hcmos' or 'legacy_id' (got '${key}')`);

  return db.withTenant(session.company_id, async (c) => {
    const rows = (await c.query(
      'SELECT id, employee_id_raw FROM exact_row WHERE batch_id=$1 ORDER BY row_no', [batchId])).rows;
    const unmatched = [];
    for (const r of rows) {
      const emp = (await c.query(`SELECT id FROM employee WHERE ${column}=$1`, [r.employee_id_raw])).rows[0];
      if (emp) {
        await c.query(`UPDATE exact_row SET matched_employee=$1, match_status='matched' WHERE id=$2`, [emp.id, r.id]);
      } else {
        await c.query(`UPDATE exact_row SET matched_employee=NULL, match_status='unmatched' WHERE id=$1`, [r.id]);
        unmatched.push({ row_id: r.id, employee_id: r.employee_id_raw });
      }
    }
    return { key, matched: rows.length - unmatched.length, unmatched };
  });
}

// ── AC-EXACT-09: control totals — sum the staged rows and compare to the totals
// DECLARED at upload. Any declared total that doesn't reconcile is a hard block.
async function controlCheck(session, batchId, exec) {
  const co = session.company_id;
  // v1.5: col 28 is GROSS (file label TOTAL ALLOWANCE). The DB columns keep their
  // 012 names (control_total_pay STORES the declared gross) — the API speaks gross.
  const gcCol = await cfg.getInt(co, 'exact.col.gross', 28, exec);
  const tdCol = await cfg.getInt(co, 'exact.col.total_deduction', 42, exec);
  const ruCol = await optCol(co, 'exact.col.roundup', exec);
  const rdCol = await optCol(co, 'exact.col.rounddown', exec);
  const b = (await exec.query(
    'SELECT control_total_pay, control_total_deduction, control_net FROM exact_batch WHERE id=$1', [batchId])).rows[0];
  const rows = (await exec.query('SELECT cells FROM exact_row WHERE batch_id=$1', [batchId])).rows;
  let sumGc = 0, sumTd = 0, sumRu = 0, sumRd = 0;
  for (const r of rows) {
    sumGc += num(r.cells[gcCol]); sumTd += num(r.cells[tdCol]);
    if (ruCol != null) sumRu += num(r.cells[ruCol]);
    if (rdCol != null) sumRd += num(r.cells[rdCol]);
  }
  const computed = { gross: round2(sumGc), total_deduction: round2(sumTd), net: round2(sumGc + sumRu - sumTd - sumRd) };
  const declared = b ? { gross: b.control_total_pay, total_deduction: b.control_total_deduction, net: b.control_net } : {};
  const mismatches = [];
  for (const k of ['gross', 'total_deduction', 'net']) {
    if (declared[k] == null) continue;                     // nothing declared → nothing to reconcile
    if (round2(num(declared[k])) !== computed[k]) mismatches.push({ field: k, declared: round2(num(declared[k])), computed: computed[k] });
  }
  return { computed, declared, ok: mismatches.length === 0, mismatches };
}

// ── AC-EXACT-08: atomic publish (all-or-nothing) ────────────────────────────
// opts.faultStep (TEST ONLY) forces a throw after the status flip to prove atomicity.
async function publish(session, batchId, opts = {}) {
  await cfg.getRequired(session.company_id, 'exact.match.key'); // publish needs a confirmed mapping

  // Phase 1: the core publish is atomic (status flip + audit + leg registration).
  await db.withTenant(session.company_id, async (c) => {
    const b = (await c.query('SELECT status FROM exact_batch WHERE id=$1', [batchId])).rows[0];
    if (!b) throw new HttpError(404, 'batch not found');
    if (b.status === 'published') throw new HttpError(409, 'already published');

    const pend = (await c.query(
      `SELECT count(*)::int n FROM exact_row WHERE batch_id=$1 AND match_status='pending'`, [batchId])).rows[0].n;
    if (pend > 0) throw new HttpError(409, 'run match before publishing');

    // Control-totals gate: a file whose declared totals don't reconcile BLOCKS
    // publish (not a warning) — checked BEFORE the status flip so nothing commits.
    const control = await controlCheck(session, batchId, c);
    if (!control.ok) throw new HttpError(409, 'control totals do not reconcile', { mismatches: control.mismatches });

    await c.query(`UPDATE exact_batch SET status='published', published_at=now() WHERE id=$1`, [batchId]);
    if (opts.faultStep === 'after_status') throw new Error('injected fault (test)');

    await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
      session.company_id, String(session.user_id || 'system'), session.role_code || 'SYS',
      'exact.publish', 'exact_batch', batchId, null, { status: 'published' }]);
    // Register the fan-out legs as pending (idempotent). This commits WITH the
    // status flip, so a published batch always has its legs to (re)drive.
    for (const leg of LEGS) {
      await c.query(
        `INSERT INTO exact_publish_leg (company_id, batch_id, leg, status)
         VALUES ($1,$2,$3,'pending') ON CONFLICT DO NOTHING`, [session.company_id, batchId, leg]);
    }
  });

  // ── AC-EXACT-11: fan-out AFTER the batch is published. Each leg runs in its own
  // transaction and reports its OWN status; a leg failing does NOT unpublish the
  // batch (partial state "GL posted, ESS push failed" is real and reportable).
  const legs = await runLegs(session, batchId, opts);
  return { batch_id: batchId, status: 'published', legs };
}

// The publish fan-out legs, in order.
const LEGS = ['gl', 'ess'];

// Perform a leg's real side effect (idempotent by a one-row-per-batch artifact).
async function performLeg(c, session, batchId, leg) {
  const co = session.company_id;
  if (leg === 'gl') {
    const control = await controlCheck(session, batchId, c);   // journal amount = net
    await c.query('INSERT INTO gl_posting (company_id, batch_id, net) VALUES ($1,$2,$3)', [co, batchId, control.computed.net]);
  } else if (leg === 'ess') {
    await c.query('INSERT INTO ess_push (company_id, batch_id) VALUES ($1,$2)', [co, batchId]);
  }
}

// Run ONE leg. A leg already 'posted' is SKIPPED (never re-run → no double-post).
// The side effect + its 'posted' mark are one transaction (atomic); on failure
// that rolls back and a SEPARATE transaction records 'failed'. opts.faultLeg
// (TEST ONLY) forces the named leg to fail before its side effect commits.
async function runLeg(session, batchId, leg, opts = {}) {
  const co = session.company_id;
  const cur = (await db.withTenant(co, (c) =>
    c.query('SELECT status FROM exact_publish_leg WHERE batch_id=$1 AND leg=$2', [batchId, leg]))).rows[0];
  if (cur && cur.status === 'posted') return { leg, status: 'posted', skipped: true };
  try {
    await db.withTenant(co, async (c) => {
      if (opts.faultLeg === leg) throw new Error(`injected ${leg} fault (test)`);
      await performLeg(c, session, batchId, leg);
      await c.query(`UPDATE exact_publish_leg SET status='posted', detail=NULL, updated_at=now() WHERE batch_id=$1 AND leg=$2`, [batchId, leg]);
    });
    return { leg, status: 'posted' };
  } catch (e) {
    // bughunt-B #8: a concurrent runner can have POSTED this leg between our
    // pre-check and this failure path — never stamp 'failed' over a durable
    // 'posted' (the journal exists; marking it failed invites a double-post).
    await db.withTenant(co, (c) =>
      c.query(`UPDATE exact_publish_leg SET status='failed', detail=$3, updated_at=now()
                WHERE batch_id=$1 AND leg=$2 AND status <> 'posted'`, [batchId, leg, String(e.message)]));
    const now = (await db.withTenant(co, (c) =>
      c.query('SELECT status FROM exact_publish_leg WHERE batch_id=$1 AND leg=$2', [batchId, leg]))).rows[0];
    if (now && now.status === 'posted') return { leg, status: 'posted', skipped: true };
    return { leg, status: 'failed', error: e.message };
  }
}

// Drive every not-yet-posted leg; posted legs are skipped. Returns per-leg status.
async function runLegs(session, batchId, opts = {}) {
  const out = {};
  for (const leg of LEGS) out[leg] = await runLeg(session, batchId, leg, opts);
  return out;
}

// Scoped retry: re-drive ONLY the non-posted legs of an already-published batch.
// This is NOT a re-publish — the GL leg is never re-attempted once posted, so a
// retry after "GL posted, ESS failed" pushes ESS without double-posting the GL.
async function retryPublishLegs(session, batchId, opts = {}) {
  return db.withTenant(session.company_id, async (c) => {
    const b = (await c.query('SELECT status FROM exact_batch WHERE id=$1', [batchId])).rows[0];
    if (!b) throw new HttpError(404, 'batch not found');
    if (b.status !== 'published') throw new HttpError(409, 'batch is not published — nothing to retry');
  }).then(() => runLegs(session, batchId, opts))
    .then((legs) => ({ batch_id: batchId, status: 'published', legs }));
}

// Parse a cell to a number (tolerate thousands separators / blanks).
function num(v) {
  const n = Number(String(v == null ? '' : v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}
const round2 = (x) => Math.round(x * 100) / 100;

// ── EX-2 / PC-1: daily-rate base — NAME-KEYED, resolved to column positions via
// the contract. INCLUDE the fixed-pay components; EXCLUDE the variable
// overtime/rotation/night ones. Because it resolves by NAME, a column moving
// position cannot silently change the base (the name-keyed test guards it), and a
// configured name missing from the contract BLOCKS rather than compute a wrong,
// money-driving base. This is the ONE base; leave pay/liability reads it too.
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

async function contractPositions(companyId) {
  const version = await cfg.getConfig(companyId, 'exact.contract.version', 'v1.2', null);
  const r = await db.query('SELECT position, header FROM exact_column WHERE version=$1', [version]);
  const map = new Map();
  for (const row of r.rows) map.set(norm(row.header), row.position);
  return map;
}

async function dailyRateBase(session, cells) {
  const co = session.company_id;
  const include = (await cfg.getConfig(co, 'exact.dailyrate.include_names', '', null)).split(',').map(norm).filter(Boolean);
  const exclude = new Set((await cfg.getConfig(co, 'exact.dailyrate.exclude_names', '', null)).split(',').map(norm).filter(Boolean));
  const pos = await contractPositions(co);

  const missing = include.filter((n) => !pos.has(n));
  if (missing.length) throw new HttpError(409, `daily-rate base: component(s) not in the column contract: ${missing.join(', ')}`);
  const conflict = include.filter((n) => exclude.has(n));
  if (conflict.length) throw new HttpError(409, `daily-rate base: component both included and excluded: ${conflict.join(', ')}`);

  return round2(include.reduce((sum, n) => sum + num(cells[pos.get(n)]), 0));
}

// EX-2 / LIAB-03 (Kira 2026-07-14): a pay column that is NEITHER included NOR
// excluded from the daily-rate base is UNCLASSIFIED. Enumerate the earnings
// (allowances-section) columns of the contract; any whose header is not in
// include_names or exclude_names (and is not the GROSS/TOTAL column) and that
// CARRIES A NON-ZERO VALUE in this row is unclassified money — the base cannot
// be trusted. Returns the offending headers (verbatim, for naming). Classified,
// zero, or gross columns never appear. This is fully configurable: once Cecilia
// moves each component into include or exclude, the list empties.
async function unclassifiedPayComponents(session, cells) {
  const co = session.company_id;
  const include = new Set((await cfg.getConfig(co, 'exact.dailyrate.include_names', '', null)).split(',').map(norm).filter(Boolean));
  const exclude = new Set((await cfg.getConfig(co, 'exact.dailyrate.exclude_names', '', null)).split(',').map(norm).filter(Boolean));
  // PENDING (Cecilia): classified as neither include nor exclude YET — a ruling
  // is outstanding. Reported separately so the block NAMES the governance hold.
  const pending = new Set((await cfg.getConfig(co, 'exact.dailyrate.pending_names', '', null)).split(',').map(norm).filter(Boolean));
  const gross = norm(await cfg.getConfig(co, 'exact.dailyrate.gross_name', 'TOTAL ALLOWANCE', null));
  const version = await cfg.getConfig(co, 'exact.contract.version', 'v1.2', null);
  const cols = (await db.query(
    "SELECT position, header FROM exact_column WHERE version=$1 AND section='allowances'", [version])).rows;
  const out = { unclassified: [], pending: [] };
  for (const c of cols) {
    const h = norm(c.header);
    if (!h || h === gross || include.has(h) || exclude.has(h)) continue;
    if (num(cells[c.position]) === 0) continue;
    (pending.has(h) ? out.pending : out.unclassified).push(c.header);
  }
  return out;
}

// EX-2 governance gate (Kira 2026-07-14): the leave-pay/liability figure must NOT
// be disclosed while the pay-component classification is unsettled. Returns a
// NOT-AVAILABLE reason string (LIAB-03: named, never a silent zero) or null when
// the base may be computed. Two fail-closed conditions:
//   1. any unclassified pay component carries money in this row → name it; or
//   2. the classification is not RATIFIED (exact.dailyrate.classification.ratified
//      ≠ 'true') → block until Cecilia signs off.
async function baseUnavailableReason(session, cells) {
  const found = await unclassifiedPayComponents(session, cells);
  if (found.pending.length) return `pay component(s) pending Cecilia's ruling (do not guess): ${found.pending.join(', ')}`;
  if (found.unclassified.length) return `unclassified pay component(s) pending EX-2 classification: ${found.unclassified.join(', ')}`;
  const ratified = norm(await cfg.getConfig(session.company_id, 'exact.dailyrate.classification.ratified', '__TBC__', null));
  if (ratified !== 'TRUE') return 'leave-pay base pending EX-2 classification ratification';
  return null;
}

// Optional column position from config: null when unset/[TBC] (contributes 0).
// `exec` is passed through when the caller already holds a transaction client.
async function optCol(co, key, exec = null) {
  const v = await cfg.getConfig(co, key, null, exec);
  return v == null || cfg.isPending(v) ? null : parseInt(v, 10);
}

// ── EX-3 / v1.5 identity: NET = GROSS (the mislabelled TOTAL ALLOWANCE col)
// + round-up − total deductions − round-down; verified against col AS. The
// round columns are [TBC] positions — unset they contribute 0. Pinned against
// the North Mara period totals in test/exact.test.js.
async function netCheck(session, cells) {
  const co = session.company_id;
  const gc = await cfg.getInt(co, 'exact.col.gross', 28, null);
  const td = await cfg.getInt(co, 'exact.col.total_deduction', 42, null);
  const ru = await optCol(co, 'exact.col.roundup');
  const rd = await optCol(co, 'exact.col.rounddown');
  const asCol = parseInt(String(await cfg.getConfig(co, 'exact.netpay.source', 'col:44', null)).split(':')[1], 10);
  const computed = round2(num(cells[gc]) + (ru == null ? 0 : num(cells[ru])) - num(cells[td]) - (rd == null ? 0 : num(cells[rd])));
  const col_as = round2(num(cells[asCol]));
  return { computed, col_as, ok: computed === col_as };
}

// AC-EXACT-07 (partial): per-row net check across a staged batch. The FULL-period
// control-totals reconciliation stays gated until a real populated period.
async function netCheckBatch(session, batchId) {
  return db.withTenant(session.company_id, async (c) => {
    const rows = (await c.query(
      'SELECT row_no, cells FROM exact_row WHERE batch_id=$1 ORDER BY row_no', [batchId])).rows;
    const results = [];
    for (const r of rows) results.push({ row_no: r.row_no, ...(await netCheck(session, r.cells)) });
    return { checked: results.length, mismatches: results.filter((x) => !x.ok) };
  });
}

async function reconcile(session, batchId) {
  await cfg.getRequired(session.company_id, 'exact.reconciliation'); // BLOCK ([TBC], full-period deferred)
  return { batch_id: batchId, reconciled: true };
}

// Endpoint wrapper: control totals (computed vs declared) inside a tenant tx.
async function controlReport(session, batchId) {
  return db.withTenant(session.company_id, (c) => controlCheck(session, batchId, c));
}

// Read-only batch view (AC-EXACT-10: published pay is read; no endpoint mutates it).
async function getBatch(session, batchId) {
  return db.withTenant(session.company_id, async (c) => {
    const b = (await c.query(
      `SELECT id, period, filename, version, status, row_count, published_at,
              control_total_pay, control_total_deduction, control_net
         FROM exact_batch WHERE id=$1`, [batchId])).rows[0];
    if (!b) throw new HttpError(404, 'batch not found');
    const counts = (await c.query(
      `SELECT match_status, count(*)::int n FROM exact_row WHERE batch_id=$1 GROUP BY match_status`, [batchId])).rows;
    const by = { pending: 0, matched: 0, unmatched: 0 };
    for (const r of counts) by[r.match_status] = r.n;
    const legRows = (await c.query(
      'SELECT leg, status, detail FROM exact_publish_leg WHERE batch_id=$1', [batchId])).rows;
    const legs = {};
    for (const r of legRows) legs[r.leg] = { status: r.status, detail: r.detail };
    return { batch: b, rows: by, legs, read_only: b.status === 'published' };
  });
}

module.exports = {
  parseCsv, gridHash, validateLayout, stage, match, publish, controlCheck, controlReport, getBatch,
  runLegs, retryPublishLegs, dailyRateBase, unclassifiedPayComponents, baseUnavailableReason,
  netCheck, netCheckBatch, reconcile, num,
};
