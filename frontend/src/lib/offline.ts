// Offline clock-in queue (F5). A punch that cannot reach the server is stored
// in IndexedDB WITH ITS ORIGINAL idempotency key and replayed on reconnect —
// the key is what makes a replay record ONCE server-side. Raw coordinates only:
// the server decides inside/outside/retry; a queued punch asserts nothing.
// Hand-rolled IDB (no dependency): one store, key = idempotency_key.

const DB_NAME = 'hcmos-ess';
const STORE = 'punch-queue';

export interface QueuedPunch {
  idempotency_key: string;
  lat: number;
  lng: number;
  accuracy: number;
  queued_at: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'idempotency_key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}

export const punchQueue = {
  add: (p: QueuedPunch) => tx('readwrite', (s) => s.put(p)),
  all: () => tx<QueuedPunch[]>('readonly', (s) => s.getAll()),
  remove: (key: string) => tx('readwrite', (s) => s.delete(key)),
  count: () => tx<number>('readonly', (s) => s.count()),
};

// ESS-5: a replay can CLASH with a punch already on the server (duplicate
// clock-in). That answer is a question, not a decision — the punch stays
// queued and is surfaced for keep-device / keep-server / keep-both.
export interface PunchConflict {
  punch: QueuedPunch;
  server: { attendance_id: string; punched_at: string; via: string; zone?: string | null };
}

// Replays queued punches through the given sender (the API clock-in call).
// A punch is removed only when the server ANSWERS (any decision — in, out,
// retry — is an answer); a network failure keeps it queued for the next pass;
// a 409 sync-conflict keeps it queued AND reports it for resolution.
export async function drainQueue(
  send: (p: QueuedPunch) => Promise<unknown>,
): Promise<{ sent: number; kept: number; conflicts: PunchConflict[] }> {
  const items = await punchQueue.all();
  let sent = 0;
  const conflicts: PunchConflict[] = [];
  for (const p of items) {
    try {
      await send(p);
      await punchQueue.remove(p.idempotency_key);
      sent += 1;
    } catch (e: unknown) {
      // An HTTP status IS a server decision (e.g. 403 outside-site): recorded,
      // dequeue. Only transport-level failures (fetch TypeError) stay queued —
      // and a 409 conflict, which needs the worker's resolution first.
      if (e && typeof e === 'object' && 'status' in e) {
        const err = e as { status: number; body?: { conflict?: { server: PunchConflict['server'] } } };
        const server = err.status === 409 ? err.body?.conflict?.server : undefined;
        if (server) {
          conflicts.push({ punch: p, server });
          continue; // stays queued pending the decision
        }
        await punchQueue.remove(p.idempotency_key);
        sent += 1;
      }
    }
  }
  return { sent, kept: (await punchQueue.count()), conflicts };
}
