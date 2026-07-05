// E3 — Attendance clock-in (ATT-01/02/03, UNI-01/06). Geofence radar
// (.fx-geo: boundary ring + you-dot + pulse), the big .punch button, and the
// capture receipt. THE SERVER DECIDES the three-way outcome: within (names
// the zone) / outside (refused) / accuracy-too-low (HOLD + retry — not a
// rejection). Raw coordinates only; the client never asserts it is inside.
// Offline punches queue in IndexedDB with their ORIGINAL idempotency key and
// replay once on reconnect (.qitem sync queue). Geofence radius is SS-3 Open
// — flagged, not invented.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { punchQueue, drainQueue, type QueuedPunch } from '../lib/offline';
import { FlagPill, Seal } from '../components/state';
import { IcCheck, IcClock, IcMapPin, IcWifiOff } from '../components/icons';

type Outcome =
  | { kind: 'in'; zone?: string }
  | { kind: 'out' }
  | { kind: 'low'; reason: string }
  | { kind: 'queued' }
  | { kind: 'err' };

function getPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      reject, { enableHighAccuracy: true, timeout: 10000 });
  });
}

const sendPunch = (p: QueuedPunch) =>
  api.clockIn({ lat: p.lat, lng: p.lng, accuracy: p.accuracy, idempotency_key: p.idempotency_key });

export default function Attendance({ ess }: { ess?: boolean } = {}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [last, setLast] = useState<QueuedPunch | null>(null);
  const [queued, setQueued] = useState<QueuedPunch[]>([]);

  const refreshQueue = () => punchQueue.all().then(setQueued).catch(() => setQueued([]));

  useEffect(() => {
    async function drain() {
      const { sent } = await drainQueue(sendPunch);
      if (sent > 0) setOutcome(null);
      refreshQueue();
    }
    drain();
    window.addEventListener('online', drain);
    return () => window.removeEventListener('online', drain);
  }, []);

  async function punch() {
    setBusy(true);
    setOutcome(null);
    let pos;
    try { pos = await getPosition(); }
    catch { setOutcome({ kind: 'err' }); setBusy(false); return; }
    const p: QueuedPunch = {
      ...pos,
      idempotency_key: `punch-${Math.round(pos.lat * 1e6)}-${Date.now()}`,
      queued_at: new Date().toISOString(),
    };
    setLast(p);
    try {
      const res = await sendPunch(p);
      // Accuracy hold is a HOLD, not a rejection (three-way outcome).
      setOutcome(res.retry ? { kind: 'low', reason: res.reason ?? t('attendance.lowAccBody') } : { kind: 'in', zone: res.zone });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'status' in err) {
        setOutcome((err as { status: number }).status === 403 ? { kind: 'out' } : { kind: 'err' });
      } else {
        await punchQueue.add(p); // transport failure → queue with the SAME key
        refreshQueue();
        setOutcome({ kind: 'queued' });
      }
    } finally {
      setBusy(false);
    }
  }

  const inZone = outcome?.kind === 'in';
  const outZone = outcome?.kind === 'out';

  return (
    <div className={ess ? 'body' : 'grid'} data-state={busy ? 'loading' : outcome?.kind ?? 'populated'} style={ess ? undefined : { maxWidth: 560 }}>
      {/* geofence radar — the you-dot and boundary are illustrative; the verdict is the server's */}
      <div className="fx-geo">
        <div className={`bound${outZone ? ' bad' : ''}`} />
        <div className={`you${outZone ? ' out' : ''}`} />
        <div className={`pulse${outZone ? ' out' : ''}`} />
        <span className={`gtag ${outZone ? 'bad' : 'ok'}`}>
          <span className="dot" />
          {busy ? t('attendance.geoLocating') : outZone ? t('attendance.geoOutside') : inZone ? t('attendance.geoWithin') : t('attendance.youAreHere')}
        </span>
        <span className="locbadge">{last ? `±${Math.round(last.accuracy)}m` : 'GPS'}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <FlagPill>{t('attendance.ssTag')}</FlagPill>
        <span className="note" style={{ padding: 0 }}>{t('attendance.ssNote')}</span>
      </div>

      <button className={`punch ${outZone ? 'out' : 'in'}`} onClick={punch} disabled={busy}>
        <IcMapPin style={{ width: 18, height: 18 }} />
        {busy ? t('attendance.capturing') : t('attendance.clockInNow')}
      </button>

      {outcome?.kind === 'in' && (
        <div className="card card-p">
          <Seal title={t('attendance.successInTitle')} sub={outcome.zone ? `${t('attendance.at')} ${outcome.zone}` : t('attendance.successInSub')} />
          {last && (
            <div className="receipt" style={{ marginTop: 10 }}>
              <div className="rh"><IcCheck style={{ width: 13, height: 13 }} />{t('attendance.capTitle')}</div>
              <div className="rr"><span className="k">{t('attendance.capTime')}</span><span className="v">{last.queued_at}</span></div>
              <div className="rr"><span className="k">{t('attendance.capAcc')}</span><span className="v">±{Math.round(last.accuracy)}m</span></div>
              <div className="rr"><span className="k">{t('attendance.capBoundary')}</span><span className="v">{outcome.zone ?? t('exact.na')}</span></div>
              <div className="rr"><span className="k">{t('attendance.capServer')}</span><span className="v d">{t('attendance.auditExt')}</span></div>
            </div>
          )}
        </div>
      )}
      {outcome?.kind === 'out' && (
        <div className="card card-p"><Seal kind="err" title={t('attendance.geoOutside')} sub={t('attendance.errBody')} /></div>
      )}
      {outcome?.kind === 'low' && (
        <div className="banner off"><IcClock /><div><b>{t('attendance.lowAccTitle')}</b> {outcome.reason} <button className="btn sm" style={{ marginLeft: 8 }} onClick={punch}>{t('attendance.retryFix')}</button></div></div>
      )}
      {outcome?.kind === 'queued' && (
        <div className="card card-p"><Seal kind="off" title={t('attendance.offTitle')} sub={t('attendance.offBody')} /></div>
      )}
      {outcome?.kind === 'err' && (
        <div className="banner err" role="alert"><IcWifiOff /><div><b>{t('attendance.errTitle')}</b> {t('attendance.errBody')}</div></div>
      )}

      {queued.length > 0 && (
        <div className="card card-p">
          <div className="shead">{t('attendance.syncQueueTitle')}</div>
          {queued.map((q) => (
            <div className="qitem" key={q.idempotency_key} style={{ marginTop: 7 }}>
              <span className="qi"><IcClock /></span>
              <span><span className="qt">{t('attendance.punchIn')}</span><br /><span className="qd">{q.queued_at}</span></span>
              <span className="qs queued"><span className="dot" />{t('attendance.stQueued')}</span>
            </div>
          ))}
          <p className="note" style={{ marginTop: 8 }}>{t('attendance.dedupeNote')} <span className="num">{t('attendance.offKey')}</span></p>
        </div>
      )}
    </div>
  );
}
