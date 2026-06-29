'use strict';
// Employee-number generator + validator for the TMCL scheme:
//
//     TMCL-<LOC>-<SEQ>     prefix · location code · per-location sequence
//
// Everything is read from the per-tenant config registry — this module encodes
// no location, prefix, width, or rollover policy. SEQ is PER-LOCATION (a separate
// counter per location code), allocated from the empno_counter table with an
// atomic upsert so simultaneous joiners at the same location never collide.
const cfg = require('./config');
const { HttpError } = require('./errors');

// Parse "key:code,key:code" → Map(key → code). An empty code marks a location
// that exists logically but is BLOCKED for generation (e.g. Nyanzaga until its
// code is confirmed). Keys are lower-cased; codes upper-cased.
function parseLocations(csv) {
  const map = new Map();
  for (const pair of String(csv || '').split(',')) {
    const s = pair.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    const key = (i < 0 ? s : s.slice(0, i)).trim().toLowerCase();
    const code = (i < 0 ? '' : s.slice(i + 1)).trim().toUpperCase();
    if (key) map.set(key, code);
  }
  return map;
}

// The active scheme for a tenant, entirely from config. `exec` (optional) is the
// caller's transaction client; pass it when inside withTenant so config reads
// share that connection (see config.js — avoids pool-exhaustion deadlock).
async function scheme(companyId, exec = null) {
  return {
    prefix:    await cfg.getConfig(companyId, 'empno.prefix', 'TMCL', exec),
    width:     await cfg.getInt(companyId, 'empno.seq_width', 4, exec),
    locations: parseLocations(await cfg.getConfig(companyId, 'empno.locations', '', exec)),
    rollover:  await cfg.getConfig(companyId, 'empno.rollover', '', exec),
  };
}

// Enabled (non-blocked) location codes.
const codesOf = (locations) => [...locations.values()].filter(Boolean);

const format = (prefix, code, seq, width) =>
  `${prefix}-${code}-${String(seq).padStart(width, '0')}`;

// Validate an emp_no against the CURRENT registry scheme. Used by tests and any
// data-layer assertion; reflects config live (e.g. once Nyanzaga's code is set,
// its numbers validate without a code change).
async function isValid(companyId, empNo, exec = null) {
  if (typeof empNo !== 'string') return false;
  const { prefix, width, locations } = await scheme(companyId, exec);
  const codes = codesOf(locations);
  if (codes.length === 0) return false;
  const re = new RegExp(`^${prefix}-(${codes.join('|')})-\\d{${width}}$`);
  return re.test(empNo);
}

// Allocate the next emp_no for a location KEY ('ho','mw','nm','nyanzaga', …).
//
// Concurrency-safe: a single INSERT … ON CONFLICT DO UPDATE serialises on the
// per-(tenant,location) counter row, so parallel joiners receive distinct,
// contiguous sequences. The counter is seeded from max(existing) for the
// location on first use, so it is correct even after legacy/manual inserts.
async function generate(client, companyId, locationKey) {
  const { prefix, width, locations, rollover } = await scheme(companyId, client);

  const key = String(locationKey || '').trim().toLowerCase();
  if (!locations.has(key)) throw new HttpError(400, `unknown location '${key}'`);
  const code = locations.get(key);
  // [TBC-NYZ] guard: a known-but-unconfigured location (empty code) is blocked.
  if (!code) throw new HttpError(409, `location '${key}' is not yet configured`);

  const r = await client.query(
    `INSERT INTO empno_counter (company_id, location, next_seq)
     VALUES ($1, $2,
       COALESCE((SELECT max(substring(emp_no from '[0-9]+$')::int)
                   FROM employee
                  WHERE company_id = $1
                    AND emp_no ~ ('^' || $3 || '-' || $2 || '-[0-9]{' || $4 || '}$')), 0) + 1)
     ON CONFLICT (company_id, location)
       DO UPDATE SET next_seq = empno_counter.next_seq + 1
     RETURNING next_seq`,
    [companyId, code, prefix, String(width)]);
  const seq = r.rows[0].next_seq;

  if (seq > Math.pow(10, width) - 1) {
    // [TBC-ROLLOVER]: behaviour past the per-location maximum is undefined until
    // governance decides. Refuse rather than silently widening the field.
    if (!rollover) {
      throw new HttpError(409, `emp_no sequence exhausted for ${code} (rollover [TBC])`);
    }
  }
  return format(prefix, code, seq, width);
}

module.exports = { generate, isValid, scheme, parseLocations, codesOf };
