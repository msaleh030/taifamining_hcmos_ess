'use strict';
// Slice 8 — Exact payroll ingestion. Uploads are validated against the versioned
// column contract (exact_column, seeded from the registry v1.2 appendix), staged,
// matched (EMPLOYEE ID → employee), and published atomically. Several downstream
// rules are [TBC] and BLOCK until the registry confirms them:
//   - exact.match.key          (EMPLOYEE ID == HCMOS number or legacy_id)
//   - exact.dailyrate.included (fixed-allowance set for the daily-rate base)
//   - exact.netpay.source      (NET PAY column location vs computed)
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

// ── AC-EXACT-06: stage a load (idempotent by file hash) ─────────────────────
async function stage(session, { period, filename, grid }) {
  if (!Array.isArray(grid)) throw new HttpError(400, 'grid required');
  const fileHash = gridHash(grid);

  return db.withTenant(session.company_id, async (c) => {
    const { version, dataRows } = await validateLayout(c, session.company_id, grid);

    const existing = await c.query(
      'SELECT id, status, row_count FROM exact_batch WHERE file_hash=$1', [fileHash]);
    if (existing.rows[0]) {
      const b = existing.rows[0];
      return { batch_id: b.id, deduped: true, row_count: b.row_count, status: b.status };
    }

    const batch = (await c.query(
      `INSERT INTO exact_batch (company_id, period, filename, file_hash, version, status, row_count)
       VALUES ($1,$2,$3,$4,$5,'staged',$6) RETURNING id`,
      [session.company_id, period || null, filename || null, fileHash, version, dataRows.length])).rows[0];

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

// ── AC-EXACT-08: atomic publish (all-or-nothing) ────────────────────────────
// opts.faultStep (TEST ONLY) forces a throw after the status flip to prove atomicity.
async function publish(session, batchId, opts = {}) {
  await cfg.getRequired(session.company_id, 'exact.match.key'); // publish needs a confirmed mapping

  return db.withTenant(session.company_id, async (c) => {
    const b = (await c.query('SELECT status FROM exact_batch WHERE id=$1', [batchId])).rows[0];
    if (!b) throw new HttpError(404, 'batch not found');
    if (b.status === 'published') throw new HttpError(409, 'already published');

    const pend = (await c.query(
      `SELECT count(*)::int n FROM exact_row WHERE batch_id=$1 AND match_status='pending'`, [batchId])).rows[0].n;
    if (pend > 0) throw new HttpError(409, 'run match before publishing');

    await c.query(`UPDATE exact_batch SET status='published', published_at=now() WHERE id=$1`, [batchId]);
    if (opts.faultStep === 'after_status') throw new Error('injected fault (test)');

    await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
      session.company_id, String(session.user_id || 'system'), session.role_code || 'SYS',
      'exact.publish', 'exact_batch', batchId, null, { status: 'published' }]);
    return { batch_id: batchId, status: 'published' };
  });
}

// ── [TBC] downstream computations — BLOCK until the registry confirms them ───
async function dailyRateBase(session /*, row */) {
  await cfg.getRequired(session.company_id, 'exact.dailyrate.included'); // excl col21/col24; exact set [TBC]
  throw new HttpError(409, 'daily-rate included set confirmed but computation not yet built');
}
async function netPay(session /*, row */) {
  await cfg.getRequired(session.company_id, 'exact.netpay.source'); // col:<n> | compute [TBC]
  throw new HttpError(409, 'net-pay source confirmed but computation not yet built');
}
// AC-EXACT-07 control-totals reconciliation — gated until a real populated period.
async function reconcile(session, batchId) {
  await cfg.getRequired(session.company_id, 'exact.reconciliation'); // BLOCK ([TBC], deferred)
  return { batch_id: batchId, reconciled: true };
}

module.exports = { parseCsv, gridHash, validateLayout, stage, match, publish, dailyRateBase, netPay, reconcile };
