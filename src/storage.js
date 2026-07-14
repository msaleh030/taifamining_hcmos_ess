'use strict';
// ONE storage foundation (Kira ruling 2026-07-14) — attendance punch photos,
// ESS documents, and every future upload go through HERE. Phase 1, on the
// kiosk's critical path. The plan (reported before building):
//   WHERE  — local filesystem under the systemd StateDirectory
//            (/var/lib/hcmos/blob/<company>/<kind>/<id>), outside the deploy
//            tree, 0700 dirs / 0600 files. `storage.driver` is the seam: the
//            'local' driver ships now; an S3-compatible object-store driver is
//            the production slot-in with no call-site changes.
//   HOW    — binary at rest; a stored_object metadata row carries kind, owner
//            entity, path, size, sha256, content type, scan status. The DB
//            stores PATHS AND HASHES, never base64 blobs.
//   SCAN   — objects write scan_status='pending'; clamdscan (when installed)
//            marks clean/infected; an absent scanner marks 'unavailable' —
//            recorded honestly, surfaced by controls, never silently skipped.
//            Enforcement is per kind on the READ side: a punch photo records
//            regardless (records-not-blocks); an ESS document is not SERVED
//            until clean (assertServable below).
//   RETAIN — per-kind config (storage.retention.<kind>, days). The sweep
//            REFUSES to run for a kind whose retention is [TBC] and names it
//            (punch photos are biometric data under TZ PDPA — the period is
//            Kira's ruling, never a code default). Deletion unlinks the
//            binary and keeps the row (deleted_at) as evidence.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const db = require('./db');
const cfg = require('./config');
const { HttpError } = require('./errors');

const KINDS = new Set(['punch-photo', 'ess-doc']);

async function rootFor(companyId, exec = null) {
  return cfg.getConfig(companyId, 'storage.local.root', '/var/lib/hcmos/blob', exec);
}

// Store a binary. NEVER throws when opts.soft is true (the punch path —
// records, not blocks): any failure returns null. Returns
// { id, path, sha256, size, scan_status } on success.
async function put(client, companyId, kind, buf, { owner_entity, owner_id, content_type, soft = false } = {}) {
  try {
    if (!KINDS.has(kind)) throw new Error(`unknown storage kind '${kind}'`);
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('empty object');
    const id = crypto.randomUUID();
    const dir = path.join(await rootFor(companyId, client), String(companyId), kind);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ext = content_type === 'image/png' ? '.png' : content_type === 'image/jpeg' ? '.jpg' : '.bin';
    const file = path.join(dir, id + ext);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    await client.query(
      `INSERT INTO stored_object(id, company_id, kind, owner_entity, owner_id, path, size, sha256, content_type, scan_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
      [id, companyId, kind, owner_entity || null, owner_id || null, file, buf.length, sha256, content_type || null]);
    // Scan asynchronously — the write never waits on a scanner.
    scanSoon(companyId, id, file);
    return { id, path: file, sha256, size: buf.length, scan_status: 'pending' };
  } catch (e) {
    if (soft) return null;
    throw e instanceof HttpError ? e : new HttpError(500, `storage: ${e.message}`);
  }
}

// clamdscan when present; 'unavailable' when not — honest, surfaced, never
// silently skipped. Fire-and-forget: failures record, they never propagate.
function scanSoon(companyId, objectId, file) {
  execFile('clamdscan', ['--no-summary', file], { timeout: 30000 }, (err) => {
    // exit 0 = clean, 1 = infected, anything else (incl. ENOENT) = unavailable
    const status = err == null ? 'clean' : err.code === 1 ? 'infected' : 'unavailable';
    db.withOwner((c) => c.query(
      `UPDATE stored_object SET scan_status=$2, scanned_at=now() WHERE id=$1`,
      [objectId, status])).catch(() => undefined);
  });
}

// READ-side gate for fail-closed kinds (ESS documents): an object is served
// only when the scanner has said CLEAN. Pending/unavailable/infected refuse,
// naming the state — the document exists, the gate is the scan.
async function assertServable(client, objectId) {
  const r = (await client.query(
    `SELECT path, scan_status, deleted_at FROM stored_object WHERE id=$1`, [objectId])).rows[0];
  if (!r || r.deleted_at) throw new HttpError(404, 'not found');
  if (r.scan_status !== 'clean') {
    throw new HttpError(409, `document not served: virus scan is '${r.scan_status}'`);
  }
  return r.path;
}

// Retention sweep. Per-kind period from storage.retention.<kind> (DAYS).
// A [TBC]/unset period REFUSES for that kind and reports it — the punch-photo
// period is a PDPA ruling (Kira), never a default. Deletion unlinks the
// binary and keeps the metadata row (deleted_at) as evidence.
async function retentionSweep(companyId) {
  const out = { swept: [], refused: [] };
  for (const kind of KINDS) {
    const v = await cfg.getConfig(companyId, `storage.retention.${kind}`, '__TBC__');
    if (cfg.isPending(v) || !Number.isFinite(Number(v)) || Number(v) <= 0) {
      out.refused.push({ kind, reason: `storage.retention.${kind} is [TBC] — retention is a governance ruling, not a default` });
      continue;
    }
    const days = Number(v);
    const rows = await db.withTenant(companyId, (c) => c.query(
      `UPDATE stored_object SET deleted_at=now()
        WHERE company_id=$1 AND kind=$2 AND deleted_at IS NULL
          AND created_at < now() - ($3 || ' days')::interval
        RETURNING id, path`, [companyId, kind, String(days)]));
    for (const r of rows.rows) { try { fs.unlinkSync(r.path); } catch { /* already gone */ } }
    out.swept.push({ kind, days, deleted: rows.rows.length });
  }
  return out;
}

module.exports = { put, assertServable, retentionSweep, KINDS };
