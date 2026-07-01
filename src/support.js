'use strict';
// Slice 9 — Support tickets (E12 body, SUP-01..04). Raise → lifecycle
// (open/in-progress/resolved/closed) → notify on every state change. Allowed
// channels come from the registry (ES-5).
const db = require('./db');
const cfg = require('./config');
const { HttpError } = require('./errors');

// Allowed forward/back transitions.
const NEXT = {
  open: ['in_progress', 'closed'],
  in_progress: ['resolved', 'closed'],
  resolved: ['closed', 'in_progress'],
  closed: [],
};

async function employeeOf(c, userId) {
  const r = await c.query('SELECT employee_id FROM app_user WHERE id=$1', [userId]);
  return r.rows[0] ? r.rows[0].employee_id : null;
}

async function notify(c, companyId, employeeId, ticketId, status) {
  await c.query(
    `INSERT INTO notification (company_id, employee_id, audience, recipient, kind, body)
     VALUES ($1,$2,'console','support',$3,$4)`,
    [companyId, employeeId, 'support.ticket', { ticket_id: ticketId, status }]);
}

async function raiseTicket(session, { subject, body, channel }) {
  if (!subject) throw new HttpError(400, 'subject required');
  const allowed = (await cfg.getConfig(session.company_id, 'support.channels', 'in_app'))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const ch = channel || allowed[0];
  if (!allowed.includes(ch)) throw new HttpError(400, `channel not allowed (${ch})`);

  return db.withTenant(session.company_id, async (c) => {
    const employeeId = await employeeOf(c, session.user_id);
    if (!employeeId) throw new HttpError(403, 'no employee for user');
    const t = (await c.query(
      `INSERT INTO support_ticket (company_id, employee_id, subject, body, channel, status)
       VALUES ($1,$2,$3,$4,$5,'open') RETURNING id, status`,
      [session.company_id, employeeId, subject, body || null, ch])).rows[0];
    await notify(c, session.company_id, employeeId, t.id, 'open');
    return { ticket_id: t.id, status: 'open', channel: ch };
  });
}

async function transition(session, ticketId, to) {
  return db.withTenant(session.company_id, async (c) => {
    const t = (await c.query('SELECT id, employee_id, status FROM support_ticket WHERE id=$1', [ticketId])).rows[0];
    if (!t) throw new HttpError(404, 'ticket not found');
    if (!NEXT[t.status].includes(to)) throw new HttpError(409, `illegal transition ${t.status} → ${to}`);
    await c.query(`UPDATE support_ticket SET status=$1, updated_at=now() WHERE id=$2`, [to, ticketId]);
    await notify(c, session.company_id, t.employee_id, ticketId, to);
    return { ticket_id: ticketId, status: to };
  });
}

module.exports = { raiseTicket, transition, NEXT };
