// F5 — attendance clock-in (port of attendance.js + the PWA offline queue).
// Reads the device GPS and sends RAW coordinates: the SERVER decides
// (inside/outside/retry) — the client never asserts it is inside. Every punch
// carries an idempotency key; a punch made offline is queued in IndexedDB and
// replayed with the SAME key on reconnect, so a re-sync records exactly once.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { punchQueue, drainQueue, type QueuedPunch } from '../lib/offline';
import { Button, Msg, Panel } from '../components/ui';

function getPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(e),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

const sendPunch = (p: QueuedPunch) =>
  api.clockIn({ lat: p.lat, lng: p.lng, accuracy: p.accuracy, idempotency_key: p.idempotency_key });

export default function Attendance() {
  const { t } = useTranslation();
  const [message, setMessage] = useState<{ kind?: 'ok' | 'blocked' | 'info'; text: string } | null>(null);
  const [queued, setQueued] = useState(0);

  const refreshQueued = () => punchQueue.count().then(setQueued).catch(() => setQueued(0));

  // Drain the offline queue on mount and whenever connectivity returns.
  useEffect(() => {
    async function drain() {
      const { sent } = await drainQueue(sendPunch);
      if (sent > 0) setMessage({ kind: 'ok', text: t('attendance.synced') });
      refreshQueued();
    }
    drain();
    window.addEventListener('online', drain);
    return () => window.removeEventListener('online', drain);
  }, [t]);

  async function punch() {
    setMessage({ kind: 'info', text: t('attendance.reading') });
    let pos;
    try { pos = await getPosition(); }
    catch { setMessage({ kind: 'blocked', text: t('attendance.noGps') }); return; }

    // A fresh key per attempt; a queued/retried send reuses it to record once.
    const p: QueuedPunch = {
      ...pos,
      idempotency_key: `punch-${Math.round(pos.lat * 1e6)}-${Date.now()}`,
      queued_at: new Date().toISOString(),
    };
    try {
      const res = await sendPunch(p);
      if (res.retry) setMessage({ kind: 'info', text: res.reason ?? '' }); // "no reliable GPS, retry in open sky"
      else setMessage({ kind: 'ok', text: `${t('attendance.clockedIn')}${res.zone ? ` ${t('attendance.at')} ${res.zone}` : ''}.` });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'status' in err) {
        // The server ANSWERED: its decision stands (403 = outside the site).
        setMessage({
          kind: 'blocked',
          text: (err as { status: number }).status === 403 ? t('attendance.outside') : t('attendance.failed'),
        });
      } else {
        // Transport failure (offline): queue with the SAME key for one-shot replay.
        await punchQueue.add(p);
        refreshQueued();
        setMessage({ kind: 'info', text: t('attendance.queued') });
      }
    }
  }

  return (
    <Panel title={t('attendance.title')} state="ready">
      <Button onClick={punch}>{t('attendance.punch')}</Button>
      {queued > 0 && <p className="text-warn mt-2">{t('attendance.queuedCount', { count: queued })}</p>}
      <Msg kind={message?.kind}>{message?.text}</Msg>
    </Panel>
  );
}
