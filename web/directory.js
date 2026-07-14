// F1 — employee directory screen. Search + site/dept/status filters + keyset
// pagination, all server-side via the F0 API client. Site scope and directory
// access are enforced by the API (RLS + the HTTP-layer deny guard); the screen
// just renders what it is allowed to see.
import { api } from './api.js';

export async function renderDirectory(el, onOpen) {
  el.innerHTML = `
    <form id="filters" class="filters">
      <input id="q" placeholder="search name or emp no" />
      <input id="dept" placeholder="department" />
      <select id="status">
        <option value="">any status</option>
        <option>active</option><option>suspended</option><option>terminated</option><option>rehire</option>
      </select>
      <button type="submit">Search</button>
    </form>
    <table class="directory">
      <thead><tr><th>Emp No</th><th>Name</th><th>Dept</th><th>Status</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <button id="more" hidden>Load more</button>
    <p id="dir-msg"></p>`;

  let cursor = null;
  const rowsEl = el.querySelector('#rows');
  const msg = el.querySelector('#dir-msg');

  async function load(reset) {
    let page;
    try {
      page = await api.directory({
        q: el.querySelector('#q').value, dept: el.querySelector('#dept').value,
        status: el.querySelector('#status').value, limit: 50, cursor,
      });
    } catch (e) {
      msg.textContent = e.status === 403 ? 'You do not have directory access.' : 'Could not load the directory.';
      return;
    }
    if (reset) rowsEl.innerHTML = '';
    for (const r of page.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${r.emp_no || ''}</td><td>${r.full_name}</td><td>${r.dept || ''}</td><td>${r.status}</td>`;
      tr.addEventListener('click', () => onOpen(r.id));
      rowsEl.appendChild(tr);
    }
    cursor = page.next_cursor;
    el.querySelector('#more').hidden = !cursor;
  }

  el.querySelector('#filters').addEventListener('submit', (e) => { e.preventDefault(); cursor = null; load(true); });
  el.querySelector('#more').addEventListener('click', () => load(false));
  load(true);
}
