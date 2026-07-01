// F5 — attendance clock-in screen. Reads the device GPS and sends the RAW
// coordinates; the SERVER decides (inside/outside/retry) — the client never asserts
// it is inside. Offline punches carry an idempotency key so a re-sync records once.
import { api } from './api.js';

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(e), { enableHighAccuracy: true, timeout: 10000 });
  });
}

export function renderAttendance(el) {
  el.innerHTML = `
    <div class="attendance">
      <h3>Clock in</h3>
      <button id="punch">Clock in with GPS</button>
      <p id="a-msg"></p>
    </div>`;
  const msg = el.querySelector('#a-msg');
  el.querySelector('#punch').addEventListener('click', async () => {
    msg.textContent = 'Reading GPS…';
    let pos;
    try { pos = await getPosition(); }
    catch { msg.textContent = 'Could not read GPS.'; return; }
    try {
      // A fresh key per attempt; a queued/retried send reuses it to record once.
      const res = await api.clockIn({ ...pos, idempotency_key: `punch-${Math.round(pos.lat * 1e6)}-${Date.now()}` });
      if (res.retry) msg.textContent = res.reason; // "no reliable GPS, retry in open sky"
      else msg.textContent = `Clocked in${res.zone ? ` at ${res.zone}` : ''}.`;
    } catch (err) {
      msg.textContent = err.status === 403 ? 'Outside your site — clock-in refused.' : 'Clock-in failed.';
    }
  });
}
