'use strict';
// Wave 9 — audit read surface (AC-AUD-01/03). The tamper-evident chain has
// existed since Slice 1, but the ONLY way to read it was raw psql on the box —
// the application exposed no way for the oversight roles to inspect it. This is
// a strictly read-only, tenant-scoped, paged window over the audit table for the
// AUD/SOD oversight set (controls.view.roles = R11/R12, gated at the route).
//
// It is deliberately NOT self-auditing: an audit-of-the-audit-read would flood
// the chain with noise on every page turn and is not required by any control.
// Filters (entity / action / actor) are parameterised — never string-built — so
// this read cannot become an injection surface onto the append-only table.
const db = require('./db');
const { HttpError } = require('./errors');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function clampInt(v, def, min, max) {
  const n = Number.parseInt(String(v == null ? '' : v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// List audit rows for the caller's tenant, newest first, with optional
// entity/action/actor filters and seq-based paging (before=<seq> pages back).
// Returns the forensic columns (source_ip / mfa_presented) — the oversight
// roles are exactly who those are for — but NOT the hash/prev_hash chain
// internals, which are a verification concern, not a reading one.
async function list(session, query = {}) {
  const limit = clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const params = [];
  const where = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };

  if (query.action) where.push(`action = ${add(String(query.action))}`);
  if (query.entity) where.push(`entity = ${add(String(query.entity))}`);
  if (query.actor) where.push(`actor = ${add(String(query.actor))}`);
  if (query.entity_id) where.push(`entity_id = ${add(String(query.entity_id))}`);
  if (query.before != null && query.before !== '') {
    const b = Number.parseInt(String(query.before), 10);
    if (!Number.isFinite(b)) throw new HttpError(400, 'before must be a seq number');
    where.push(`seq < ${add(b)}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.withTenant(session.company_id, async (c) => {
    const rows = (await c.query(
      `SELECT seq, ts, actor, role, action, entity, entity_id, before, after,
              source_ip, mfa_presented
         FROM audit ${whereSql}
        ORDER BY seq DESC
        LIMIT ${add(limit)}`, params)).rows;
    // next_before lets the client page: pass the smallest seq back as ?before=.
    const next_before = rows.length === limit ? rows[rows.length - 1].seq : null;
    return { count: rows.length, limit, next_before, rows };
  });
}

module.exports = { list };
