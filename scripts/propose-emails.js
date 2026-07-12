'use strict';
// DRAFT proposed-email list (Kira ruling 2026-07-12): the convention is
// firstname.lastname@taifamining.tz for every employee, BUT the system must
// NOT invent logins — a derived address may not exist as a mailbox, and two
// same-named people derive the SAME address (whoever sets the password first
// owns the other's payslip). So this script only PROPOSES:
//   • derives firstname.lastname@taifamining.tz per employee without an email;
//   • detects ALL collisions — within the proposals AND against addresses
//     already assigned — and marks them;
//   • writes the full list (names — PII) to a 600-mode file ON THE BOX for
//     Taifa IT/HR to confirm; prints COUNTS ONLY (safe for a CI log).
// Confirmed addresses come back through the employee-master enrich load
// (pf + site + name + company_email), where a duplicate is an EXCEPTION.
//
//   UAT_COMPANY=<uuid> node scripts/propose-emails.js [/root/proposed-emails.csv]
const fs = require('node:fs');
const db = require('../src/db');

const DOMAIN = 'taifamining.tz';
const token = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');

function propose(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null; // single-token name: nothing to derive, needs a human call
  const first = token(parts[0]), last = token(parts[parts.length - 1]);
  if (!first || !last) return null;
  return `${first}.${last}@${DOMAIN}`;
}

async function run(companyId, outPath) {
  if (!companyId) throw new Error('UAT_COMPANY (companyId) is required');
  return db.withOwner(async (c) => {
    const rows = (await c.query(
      `SELECT e.legacy_id AS pf, e.full_name, s.name AS site, lower(e.email) AS email
         FROM employee e JOIN site s ON s.id = e.site_id
        WHERE e.company_id = $1 AND e.status = 'active'
        ORDER BY s.name, e.full_name`, [companyId])).rows;

    const assigned = new Set(rows.map((r) => r.email).filter(Boolean));
    const proposalCount = new Map();
    const drafts = [];
    for (const r of rows) {
      if (r.email) { drafts.push({ ...r, proposed: '', status: 'already-assigned' }); continue; }
      const p = propose(r.full_name);
      if (!p) { drafts.push({ ...r, proposed: '', status: 'cannot-derive (single-token name)' }); continue; }
      proposalCount.set(p, (proposalCount.get(p) || 0) + 1);
      drafts.push({ ...r, proposed: p, status: 'proposed' });
    }
    for (const d of drafts) {
      if (d.status !== 'proposed') continue;
      if ((proposalCount.get(d.proposed) || 0) > 1) d.status = 'COLLISION (same derived address for >1 employee)';
      else if (assigned.has(d.proposed)) d.status = 'COLLISION (derived address already assigned to someone else)';
    }

    const q = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const csv = ['pf,site,full_name,current_email,proposed_email,status']
      .concat(drafts.map((d) => [d.pf, d.site, d.full_name, d.email || '', d.proposed, d.status].map(q).join(',')))
      .join('\n') + '\n';
    fs.writeFileSync(outPath, csv, { mode: 0o600 });

    const count = (s) => drafts.filter((d) => d.status === s || d.status.startsWith(s)).length;
    return {
      employees: rows.length,
      already_assigned: count('already-assigned'),
      proposed_ok: count('proposed'),
      collisions: drafts.filter((d) => d.status.startsWith('COLLISION')).length,
      cannot_derive: count('cannot-derive'),
      report: outPath,
    };
  });
}

async function main() {
  const out = process.argv[2] || '/root/proposed-emails.csv';
  const res = await run(process.env.UAT_COMPANY, out);
  console.log(JSON.stringify(res, null, 2)); // counts only — names stay in the 600 file
  await db.close();
}

if (require.main === module) main().catch((e) => { console.error('[propose-emails] FAILED:', e.message); process.exit(1); });
module.exports = { run, propose };
