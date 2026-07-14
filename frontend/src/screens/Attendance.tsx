// E3 — Attendance (ATT-01/02/03, UNI-01/06). ESS-5 completes the pair: the
// screen is DIRECTION-AWARE (clock-in off-shift, clock-out on-shift — AC-ATT-02
// only closes an OPEN punch; 409 renders the reference's "You are not clocked
// in" empty state) and carries the offline SYNC-CONFLICT resolution UI:
// a replayed queued punch that clashes with a punch already on the server
// ("Duplicate clock-in — two open punches with no clock-out between them")
// stays queued and renders the versus card — device vs server — with
// keep-device / keep-server / keep-both. The decision is the server's to
// execute and AUDIT (UNI-06); this screen only asks the question.
// THE SERVER DECIDES the three-way geofence outcome: within / outside /
// accuracy-too-low (HOLD + retry). Raw coordinates only; the client never
// asserts it is inside. Geofence radius is SS-3 Open — flagged, not invented.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';
import type { AttStatusOut, ConflictServer } from '../lib/types';
import { punchQueue, drainQueue, type QueuedPunch, type PunchConflict } from '../lib/offline';
import { FlagPill, Seal } from '../components/state';
import { IcCheck, IcClock, IcLogOut, IcMapPin, IcShield, IcWifiOff } from '../components/icons';

type Outcome =
  | { kind: 'in'; zone?: string }
  | { kind: 'closed'; since?: string }      // clock-out success — shift closed
  | { kind: 'emptyOut' }                    // clock-out with no open punch (409)
  | { kind: 'out' }                         // outside boundary (403)
  | { kind: 'low'; reason: string }
  | { kind: 'queued' }
  | { kind: 'resolved'; flagged?: string }  // conflict decision executed + audited
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

// "10h 02m" between a server timestamp and now — display only.
function workedSince(since: string | null | undefined): string | null {
  if (!since) return null;
  const t = new Date(since.replace(' ', 'T')).getTime();
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

export default function Attendance({ ess }: { ess?: boolean } = {}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [last, setLast] = useState<QueuedPunch | null>(null);
  const [queued, setQueued] = useState<QueuedPunch[]>([]);
  const [shift, setShift] = useState<AttStatusOut | null>(null);
  const [conflict, setConflict] = useState<PunchConflict | null>(null);
  const [choice, setChoice] = useState<'keep_device' | 'keep_server' | 'keep_both'>('keep_device');

  const refreshQueue = () => punchQueue.all().then(setQueued).catch(() => setQueued([]));
  const refreshShift = () => api.attendanceStatus().then(setShift).catch(() => setShift(null));

  useEffect(() => {
    async function drain() {
      const { sent, conflicts } = await drainQueue(sendPunch);
      if (sent > 0) { setOutcome(null); refreshShift(); }
      if (conflicts.length > 0) setConflict(conflicts[0]); // one decision at a time
      refreshQueue();
    }
    drain();
    refreshShift();
    window.addEventListener('online', drain);
    return () => window.removeEventListener('online', drain);
  }, []);

  const onShift = !!shift?.open;

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
      if (onShift) {
        const res = await api.clockOut(p);
        setOutcome(res.retry ? { kind: 'low', reason: res.reason ?? t('attendance.lowAccBody') } : { kind: 'closed', since: res.since });
      } else {
        const res = await sendPunch(p);
        // Accuracy hold is a HOLD, not a rejection (three-way outcome).
        setOutcome(res.retry ? { kind: 'low', reason: res.reason ?? t('attendance.lowAccBody') } : { kind: 'in', zone: res.zone });
      }
      refreshShift();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        const server = (err.body as { conflict?: { server: ConflictServer } } | undefined)?.conflict?.server;
        if (err.status === 409 && server) {
          // Live duplicate clock-in — same conflict, same card, same decision.
          setConflict({ punch: p, server });
        } else if (err.status === 409) {
          setOutcome({ kind: 'emptyOut' });
          refreshShift();
        } else {
          setOutcome(err.status === 403 ? { kind: 'out' } : { kind: 'err' });
        }
      } else if (err && typeof err === 'object' && 'status' in err) {
        setOutcome({ kind: 'err' });
      } else {
        await punchQueue.add(p); // transport failure → queue with the SAME key
        refreshQueue();
        setOutcome({ kind: 'queued' });
      }
    } finally {
      setBusy(false);
    }
  }

  async function resolve() {
    if (!conflict) return;
    setBusy(true);
    try {
      const res = await api.resolveConflict({
        resolution: choice,
        server_attendance_id: conflict.server.attendance_id,
        device: {
          lat: conflict.punch.lat, lng: conflict.punch.lng, accuracy: conflict.punch.accuracy,
          idempotency_key: conflict.punch.idempotency_key, queued_at: conflict.punch.queued_at,
        },
      });
      if (res.retry) {
        setOutcome({ kind: 'low', reason: res.reason ?? t('attendance.lowAccBody') });
      } else {
        await punchQueue.remove(conflict.punch.idempotency_key).catch(() => undefined);
        setConflict(null);
        setOutcome({ kind: 'resolved', flagged: res.flagged });
        refreshShift();
        refreshQueue();
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        // Already resolved / stale — the server state moved; refetch and drop.
        setConflict(null);
        refreshShift();
        refreshQueue();
      } else if (err instanceof ApiError && err.status === 403) {
        setOutcome({ kind: 'out' });
      } else {
        setOutcome({ kind: 'err' });
      }
    } finally {
      setBusy(false);
    }
  }

  const inZone = outcome?.kind === 'in';
  const outZone = outcome?.kind === 'out';

  const choices: Array<{ id: typeof choice; title: string; detail: string }> = conflict ? [
    { id: 'keep_device', title: t('attendance.keepDevice'), detail: `${conflict.punch.queued_at} · ESS` },
    { id: 'keep_server', title: t('attendance.keepServer'), detail: `${conflict.server.punched_at} · ${conflict.server.via === 'kiosk' ? t('attendance.viaKiosk') : t('attendance.viaPhone')}` },
    { id: 'keep_both', title: t('attendance.keepBoth'), detail: t('attendance.resolveHint') },
  ] : [];

  return (
    <div className={ess ? 'body' : 'grid'} data-state={busy ? 'loading' : conflict ? 'conflict' : outcome?.kind ?? 'populated'} style={ess ? undefined : { maxWidth: 560 }}>
      {/* shift context — the server's answer, not the device's memory */}
      <div className="shiftbar card card-p" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <span className={`qs ${onShift ? 'synced' : 'queued'}`}><span className="dot" />{onShift ? t('attendance.onShift') : t('attendance.offShift')}</span>
        <span className="note" style={{ padding: 0 }}>
          {t('attendance.since')}: <span className="num">{onShift && shift?.since ? shift.since : t('attendance.na')}</span>
          {onShift && workedSince(shift?.since) ? <> · <span className="num">{workedSince(shift?.since)}</span> {t('attendance.worked')}</> : null}
        </span>
      </div>

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

      <button className={`punch ${onShift ? 'out' : 'in'}`} onClick={punch} disabled={busy || !!conflict}>
        {onShift ? <IcLogOut style={{ width: 18, height: 18 }} /> : <IcMapPin style={{ width: 18, height: 18 }} />}
        {busy ? t('attendance.capturing') : onShift ? t('attendance.clockOutNow') : t('attendance.clockInNow')}
      </button>

      {/* ── sync conflict — the versus card. The worker decides; the server executes + audits. ── */}
      {conflict && (
        <div className="card card-p" data-state="conflict">
          <div className="confhead" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <IcClock style={{ width: 18, height: 18 }} />
            <div>
              <div className="qt"><b>{t('attendance.conflictTitle')}</b></div>
              <div className="qd">{t('attendance.conflictKind')}</div>
            </div>
          </div>
          <p className="note" style={{ marginTop: 8 }}>{t('attendance.conflictBody')}</p>
          <div className="versus" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <div className="ver card card-p">
              <div className="qd">{t('attendance.verDevice')}</div>
              <div className="qt num">{conflict.punch.queued_at}</div>
              <div className="qd">{t('attendance.verVia')} {t('attendance.viaPhone')}</div>
              <div className="qd num">{conflict.punch.idempotency_key}</div>
            </div>
            <div className="ver card card-p">
              <div className="qd">{t('attendance.verServer')}</div>
              <div className="qt num">{conflict.server.punched_at}</div>
              <div className="qd">{t('attendance.verVia')} {conflict.server.via === 'kiosk' ? t('attendance.viaKiosk') : t('attendance.viaPhone')}</div>
              <div className="qd num">{conflict.server.attendance_id}</div>
            </div>
          </div>
          <div className="choices" style={{ marginTop: 8 }}>
            {choices.map((c) => (
              <label key={c.id} className={`choice${choice === c.id ? ' sel' : ''}`} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 4px', cursor: 'pointer' }}>
                <input type="radio" name="resolution" checked={choice === c.id} onChange={() => setChoice(c.id)} />
                <span><span className="qt">{c.title}</span><br /><span className="qd">{c.detail}</span></span>
              </label>
            ))}
          </div>
          <div className="audit" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <IcShield style={{ width: 13, height: 13 }} />
            <span className="note" style={{ padding: 0 }}>{t('attendance.auditExt')}</span>
          </div>
          <button className="btn b block" style={{ marginTop: 8 }} onClick={resolve} disabled={busy}>
            <IcCheck style={{ width: 15, height: 15 }} /> {t('attendance.resolve')}
          </button>
        </div>
      )}

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
      {outcome?.kind === 'closed' && (
        <div className="card card-p">
          <Seal title={t('attendance.successOutTitle')}
            sub={`${t('attendance.successOutSub')}${workedSince(outcome.since) ? ` · ${workedSince(outcome.since)} ${t('attendance.worked')}` : ''}`} />
        </div>
      )}
      {outcome?.kind === 'emptyOut' && (
        <div className="card card-p"><Seal kind="off" title={t('attendance.emptyOutTitle')} sub={t('attendance.emptyOutBody')} /></div>
      )}
      {outcome?.kind === 'resolved' && (
        <div className="card card-p">
          <Seal title={t('attendance.resolve')} sub={t('attendance.auditExt')} />
          {outcome.flagged && <p className="note" style={{ marginTop: 6 }}><FlagPill>{outcome.flagged}</FlagPill></p>}
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
          {queued.map((q) => {
            const isConflict = conflict?.punch.idempotency_key === q.idempotency_key;
            return (
              <div className={`qitem${isConflict ? ' conflict' : ''}`} key={q.idempotency_key} style={{ marginTop: 7 }}>
                <span className="qi"><IcClock /></span>
                <span><span className="qt">{t('attendance.punchIn')}</span><br /><span className="qd">{q.queued_at}</span></span>
                <span className={`qs ${isConflict ? 'conflict' : 'queued'}`}><span className="dot" />{isConflict ? t('attendance.stConflict') : t('attendance.stQueued')}</span>
              </div>
            );
          })}
          <p className="note" style={{ marginTop: 8 }}>{t('attendance.dedupeNote')} <span className="num">{t('attendance.offKey')}</span></p>
        </div>
      )}
    </div>
  );
}
