'use strict';
// Minimal pure-Node PostgreSQL client (wire protocol v3).
//
// We can't install the `pg` package (no registry access in this environment),
// so this implements just enough of the protocol to run parameterised queries
// safely: Parse/Bind/Describe/Execute/Sync (the "extended query" flow). Binding
// parameters server-side means values are never interpolated into SQL — no
// injection surface. Auth is `trust` (configured by scripts/setup-db.sh), so we
// only have to answer AuthenticationOk; cleartext/MD5 are also handled for
// resilience.
const net = require('node:net');
const crypto = require('node:crypto');

// A handful of OIDs we decode from text into JS types.
const OID = { BOOL: 16, INT8: 20, INT2: 21, INT4: 23, JSON: 114, JSONB: 3802, NUMERIC: 1700 };

function decode(oid, raw) {
  if (raw === null) return null;
  switch (oid) {
    case OID.BOOL: return raw === 't';
    case OID.INT2:
    case OID.INT4:
    case OID.INT8: return Number(raw);
    case OID.NUMERIC: return Number(raw);
    case OID.JSON:
    case OID.JSONB: return JSON.parse(raw);
    default: return raw; // uuid, text, timestamptz, etc. stay strings
  }
}

function encodeParam(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---- message buffer writer ------------------------------------------------
class W {
  constructor() { this.chunks = []; }
  i32(n) { const b = Buffer.allocUnsafe(4); b.writeInt32BE(n | 0); this.chunks.push(b); return this; }
  i16(n) { const b = Buffer.allocUnsafe(2); b.writeInt16BE(n & 0xffff); this.chunks.push(b); return this; }
  str(s) { this.chunks.push(Buffer.from(s, 'utf8')); this.chunks.push(Buffer.from([0])); return this; }
  bytes(b) { this.chunks.push(b); return this; }
  // frame: 1-byte type + int32 length (length includes itself).
  frame(type) {
    const body = Buffer.concat(this.chunks);
    const head = Buffer.allocUnsafe(type ? 5 : 4);
    let off = 0;
    if (type) head.writeUInt8(type.charCodeAt(0), off++), 0;
    head.writeInt32BE(body.length + 4, off);
    return Buffer.concat([head, body]);
  }
}

class Client {
  constructor(opts) {
    this.opts = opts;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this._queue = [];        // pending command resolvers
    this._connectCbs = null; // {resolve,reject}
    this._cur = null;        // current query accumulator
    this._closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this._connectCbs = { resolve, reject };
      this.sock = net.connect({ host: this.opts.host, port: this.opts.port });
      this.sock.on('connect', () => {
        const w = new W();
        w.i32(196608); // protocol 3.0
        w.str('user').str(this.opts.user);
        w.str('database').str(this.opts.database);
        w.str('application_name').str('hcmos');
        w.chunks.push(Buffer.from([0])); // terminator
        this.sock.write(w.frame(null));
      });
      this.sock.on('data', (d) => this._onData(d));
      this.sock.on('error', (e) => this._fail(e));
      this.sock.on('close', () => { this._closed = true; this._fail(new Error('connection closed')); });
    });
  }

  _fail(err) {
    if (this._connectCbs) { this._connectCbs.reject(err); this._connectCbs = null; }
    while (this._queue.length) this._queue.shift().reject(err);
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    // Each message: 1 byte type, int32 length (incl. length field).
    while (this.buf.length >= 5) {
      const type = String.fromCharCode(this.buf[0]);
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) break;
      const body = this.buf.subarray(5, 1 + len);
      this.buf = this.buf.subarray(1 + len);
      this._handle(type, body);
    }
  }

  _handle(type, body) {
    switch (type) {
      case 'R': { // Authentication
        const sub = body.readInt32BE(0);
        if (sub === 0) break; // AuthenticationOk
        if (sub === 3) { // cleartext password
          const w = new W(); w.str(this.opts.password || '');
          this.sock.write(w.frame('p')); break;
        }
        if (sub === 5) { // md5
          const salt = body.subarray(4, 8);
          const inner = crypto.createHash('md5')
            .update((this.opts.password || '') + this.opts.user).digest('hex');
          const outer = crypto.createHash('md5')
            .update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
          const w = new W(); w.str('md5' + outer);
          this.sock.write(w.frame('p')); break;
        }
        this._fail(new Error('unsupported auth method ' + sub));
        break;
      }
      case 'S': break; // ParameterStatus — ignore
      case 'K': break; // BackendKeyData — ignore
      case 'Z': // ReadyForQuery
        if (this._connectCbs) { this._connectCbs.resolve(this); this._connectCbs = null; }
        else if (this._cur) { this._finishCurrent(); }
        break;
      case 'T': { // RowDescription
        if (!this._cur) break;
        const n = body.readInt16BE(0); let off = 2; const fields = [];
        for (let i = 0; i < n; i++) {
          const end = body.indexOf(0, off);
          const name = body.toString('utf8', off, end);
          off = end + 1;
          const oid = body.readInt32BE(off + 6); // skip tableOID(4)+colNo(2)
          off += 18; // name already consumed; 18 = 4+2+4+2+4+2
          fields.push({ name, oid });
        }
        this._cur.fields = fields;
        break;
      }
      case 'D': { // DataRow
        if (!this._cur) break;
        const n = body.readInt16BE(0); let off = 2; const row = {};
        for (let i = 0; i < n; i++) {
          const len = body.readInt32BE(off); off += 4;
          let val = null;
          if (len !== -1) { val = body.toString('utf8', off, off + len); off += len; }
          const f = this._cur.fields[i];
          row[f.name] = decode(f.oid, val);
        }
        this._cur.rows.push(row);
        break;
      }
      case 'C': break; // CommandComplete
      case 'I': break; // EmptyQueryResponse
      case '1': case '2': case '3': case 'n': case 't': break; // Parse/Bind/Close/NoData/ParamDesc
      case 'E': { // ErrorResponse
        if (this._cur) this._cur.error = parseErr(body);
        else if (this._connectCbs) { this._connectCbs.reject(new Error('auth: ' + parseErr(body).message)); this._connectCbs = null; }
        break;
      }
      case 'N': break; // NoticeResponse — ignore
      default: break;
    }
  }

  _finishCurrent() {
    const cur = this._cur; this._cur = null;
    if (cur.error) cur.reject(Object.assign(new Error(cur.error.message), cur.error));
    else cur.resolve({ rows: cur.rows, fields: cur.fields });
    this._drain();
  }

  _drain() {
    if (this._cur || this._queue.length === 0) return;
    const job = this._queue.shift();
    this._cur = job;
    this.sock.write(job.payload);
  }

  // Parameterised query via the extended protocol.
  query(text, params = []) {
    return new Promise((resolve, reject) => {
      const parse = new W();
      parse.str('').str(text).i16(0); // unnamed stmt, 0 declared param types
      const bind = new W();
      bind.str('').str('');           // portal, stmt
      bind.i16(0);                    // 0 param format codes -> all text
      bind.i16(params.length);
      for (const p of params) {
        const e = encodeParam(p);
        if (e === null) { bind.i32(-1); }
        else { const b = Buffer.from(e, 'utf8'); bind.i32(b.length).bytes(b); }
      }
      bind.i16(1).i16(0);             // 1 result format code: text
      const describe = new W(); describe.bytes(Buffer.from('P')).str('');
      const execute = new W(); execute.str('').i32(0);
      const sync = new W();
      const payload = Buffer.concat([
        parse.frame('P'), bind.frame('B'), describe.frame('D'),
        execute.frame('E'), sync.frame('S'),
      ]);
      this._queue.push({ payload, rows: [], fields: [], error: null, resolve, reject });
      this._drain();
    });
  }

  async end() {
    if (this._closed || !this.sock) return;
    try { this.sock.write(new W().frame('X')); } catch { /* ignore */ }
    this.sock.destroy();
    this._closed = true;
  }
}

function parseErr(body) {
  const out = {}; let off = 0;
  while (off < body.length && body[off] !== 0) {
    const code = String.fromCharCode(body[off]); off += 1;
    const end = body.indexOf(0, off);
    const val = body.toString('utf8', off, end); off = end + 1;
    if (code === 'M') out.message = val;
    else if (code === 'C') out.code = val;
    else if (code === 'D') out.detail = val;
  }
  return out;
}

// ---- tiny pool ------------------------------------------------------------
class Pool {
  constructor(opts, max = 6) { this.opts = opts; this.max = max; this.idle = []; this.size = 0; this.waiters = []; }
  async acquire() {
    if (this.idle.length) return this.idle.pop();
    if (this.size < this.max) {
      this.size++;
      try { const c = await new Client(this.opts).connect(); return c; }
      catch (e) { this.size--; throw e; }
    }
    return new Promise((res) => this.waiters.push(res));
  }
  release(c) {
    if (c._closed) { this.size--; if (this.waiters.length) this._refill(); return; }
    const w = this.waiters.shift();
    if (w) w(c); else this.idle.push(c);
  }
  async _refill() {
    if (this.size < this.max && this.waiters.length) {
      this.size++;
      try { const c = await new Client(this.opts).connect(); const w = this.waiters.shift(); w ? w(c) : this.idle.push(c); }
      catch { this.size--; }
    }
  }
  async end() {
    const all = this.idle.splice(0);
    await Promise.all(all.map((c) => c.end()));
  }
}

module.exports = { Client, Pool };
