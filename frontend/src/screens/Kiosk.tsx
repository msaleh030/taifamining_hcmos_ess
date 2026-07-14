// Shared KIOSK (Kira rulings 2026-07-14) — the field-PIN "large-data" state:
// "Shared kiosk, pick who is signing in" / "Kioski cha pamoja, chagua
// anayeingia". One device at a site, many people; the PIN identifies the
// person. The screen is CLOCK-IN/OUT ONLY by server enforcement (a kiosk
// session cannot reach anything else); the session is single-use — it dies
// with the punch — so this screen simply resets to the roster for the next
// person. PHOTO-ON-PUNCH: the camera captures at the moment of punch and the
// photo rides with the punch request; if the camera fails or is denied the
// punch STILL goes through and the server flags the record (records, never
// blocks — a shift change of 200 people is not gated on a lens).
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isApiError, kioskApi, KioskWorker } from '../lib/api';
import { setLanguage } from '../lib/i18n';
import { IcCheck, IcClock, IcLock, IcSearch, IcUser } from '../components/icons';

const KIOSK_KEY = 'hcmos.kiosk_id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function capturePhoto(): Promise<string | null> {
  // Best-effort frame grab. ANY failure → null → the punch proceeds flagged.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => setTimeout(r, 150)); // first frames are black
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    stream.getTracks().forEach((t) => t.stop());
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

export default function Kiosk() {
  const { t, i18n } = useTranslation();
  const [kioskId, setKioskId] = useState<string | null>(localStorage.getItem(KIOSK_KEY));
  const [site, setSite] = useState('');
  const [workers, setWorkers] = useState<KioskWorker[]>([]);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<KioskWorker | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ dir: 'in' | 'out'; who: string; photo: boolean } | null>(null);
  const resetTimer = useRef<number | undefined>(undefined);

  const loadRoster = async (dev: string) => {
    const r = await kioskApi.roster(dev);
    setSite(r.site);
    setWorkers(r.workers);
  };

  useEffect(() => {
    if (kioskId) loadRoster(kioskId).catch(() => { setMessage(t('kiosk.err')); });
    return () => window.clearTimeout(resetTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kioskId]);

  function enrol(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dev = String(new FormData(e.currentTarget).get('kiosk_device') ?? '').trim().toLowerCase();
    if (!UUID_RE.test(dev)) { setMessage(t('kiosk.err')); return; }
    // Only a roster answer proves this is an enrolled ACTIVE kiosk — a typo never sticks.
    loadRoster(dev).then(() => { localStorage.setItem(KIOSK_KEY, dev); setKioskId(dev); setMessage(null); })
      .catch(() => setMessage(t('kiosk.err')));
  }

  async function punch(dir: 'in' | 'out', pin: string) {
    if (!kioskId || !picked) return;
    setBusy(true); setMessage(null);
    try {
      const photo = await capturePhoto();
      const login = await kioskApi.login(kioskId, picked.employee_id, pin);
      const res = await kioskApi.punch(login.token, dir, photo);
      setDone({ dir, who: picked.full_name, photo: res.photo_recorded });
      setPicked(null); setPin('');
      resetTimer.current = window.setTimeout(() => setDone(null), 4000); // next person starts clean
    } catch (err) {
      const blocked = isApiError(err) && err.status === 403 && (err.body as { blocked?: string } | null)?.blocked;
      if (blocked === 'suspended') setMessage(t('kiosk.blockedSusp'));
      else if (blocked === 'terminated') setMessage(t('kiosk.blockedTerm'));
      else if (isApiError(err) && err.status === 409) setMessage(t('kiosk.notIn'));
      else setMessage(t('kiosk.err'));
    } finally {
      setBusy(false);
    }
  }

  const [pin, setPin] = useState('');
  function submitPin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); // Enter defaults to clock-in
    punch('in', pin.trim());
  }

  const q = filter.trim().toLowerCase();
  const shown = q
    ? workers.filter((w) => w.full_name.toLowerCase().includes(q) || (w.emp_no ?? '').toLowerCase().includes(q))
    : workers;

  return (
    <div className="ess" style={{ minHeight: '100vh' }} data-surface-hint="kiosk">
      <div className="topbar">
        <IcClock style={{ width: 16, height: 16 }} />
        <div>
          <div className="tt">{t('kiosk.title')}</div>
          <div className="ts">{site ? `${site} · ` : ''}{t('kiosk.sub')}</div>
        </div>
        <button type="button" className="pill" style={{ marginLeft: 'auto' }}
          onClick={() => setLanguage(i18n.language === 'en' ? 'sw' : 'en')}>
          {i18n.language === 'en' ? 'SW · Kiswahili' : 'EN · English'}
        </button>
      </div>
      <div className="body">
        {message && <div className="banner err" style={{ marginBottom: 10 }}>{message}</div>}

        {!kioskId && (
          <form className="lf-inner" onSubmit={enrol}>
            <div className="lockup">
              <span className="ic"><IcLock style={{ width: 22, height: 22 }} /></span>
              <h3>{t('kiosk.enrolT')}</h3><p>{t('kiosk.enrolB')}</p>
            </div>
            <label className="inp"><IcUser /><input name="kiosk_device" placeholder={t('kiosk.enrolField')} autoComplete="off" /></label>
            <button className="btn p block" type="submit">{t('kiosk.enrolBtn')}</button>
          </form>
        )}

        {kioskId && done && (
          <div className="lockup">
            <span className="ic" style={{ background: 'rgba(11,143,68,.14)', color: 'var(--green)' }}>
              <IcCheck style={{ width: 24, height: 24 }} />
            </span>
            <h3>{done.dir === 'in' ? t('kiosk.doneIn') : t('kiosk.doneOut')}</h3>
            <p>{done.who}</p>
            <p>{done.photo ? t('kiosk.photoOk') : t('kiosk.photoMissing')}</p>
            <button className="btn g" onClick={() => setDone(null)}>{t('kiosk.next')}</button>
          </div>
        )}

        {kioskId && !done && !picked && (
          <>
            <label className="inp" style={{ marginBottom: 10 }}>
              <IcSearch />
              <input value={filter} onChange={(e) => setFilter(e.target.value)}
                placeholder={t('kiosk.search')} autoComplete="off" />
            </label>
            <div className="pick" style={{ maxHeight: '60vh' }}>
              {shown.map((w) => (
                <button key={w.employee_id} className="inp" style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}
                  onClick={() => { setPicked(w); setMessage(null); }}>
                  <span>{w.full_name}</span>
                  <span className="num" style={{ color: 'var(--muted)' }}>{w.emp_no ?? '—'}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {kioskId && !done && picked && (
          <form className="lf-inner" onSubmit={submitPin}>
            <div className="shiftbar">
              <div>
                <div className="nm">{picked.full_name}</div>
                <div className="mt">{picked.emp_no ?? '—'}</div>
              </div>
            </div>
            <label className="inp"><IcLock />
              <input name="pin" type="password" inputMode="numeric" value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder={t('kiosk.pinFor') + ' ' + picked.full_name} autoComplete="off" autoFocus />
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn p" style={{ flex: 1 }} disabled={busy} type="button" onClick={() => punch('in', pin.trim())}>
                {t('kiosk.clockInNow')}
              </button>
              <button className="btn g" style={{ flex: 1 }} disabled={busy} type="button" onClick={() => punch('out', pin.trim())}>
                {t('kiosk.clockOutNow')}
              </button>
            </div>
            <button className="btn g block" type="button" onClick={() => { setPicked(null); setPin(''); }}>{t('kiosk.back')}</button>
          </form>
        )}
      </div>
    </div>
  );
}
