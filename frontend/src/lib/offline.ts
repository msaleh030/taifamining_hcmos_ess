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

// Replays queued punches through the given sender (the API clock-in call).
// A punch is removed only when the server ANSWERS (any decision — in, out,
// retry — is an answer); a network failure keeps it queued for the next pass.
export async function drainQueue(
  send: (p: QueuedPunch) => Promise<unknown>,
): Promise<{ sent: number; kept: number }> {
  const items = await punchQueue.all();
  let sent = 0;
  for (const p of items) {
    try {
      await send(p);
      await punchQueue.remove(p.idempotency_key);
      sent += 1;
    } catch (e: unknown) {
      // An HTTP status IS a server decision (e.g. 403 outside-site): recorded,
      // dequeue. Only transport-level failures (fetch TypeError) stay queued.
      if (e && typeof e === 'object' && 'status' in e) {
        await punchQueue.remove(p.idempotency_key);
        sent += 1;
      }
    }
  }
  return { sent, kept: (await punchQueue.count()) };
}
