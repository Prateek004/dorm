/* ============================================================
   Sthappit / DormBook — Frontend SPA
   Single file, no build step required.
   ============================================================ */

'use strict';

const App = (() => {

  // ── State ─────────────────────────────────────────────────
  let state = {
    token:       null,
    user:        null,
    currentPage: 'dashboard',
    cache:       {},
  };

  // ── API base ──────────────────────────────────────────────
  const API = '/api';

  // ── Bootstrap ─────────────────────────────────────────────
  function init() {
    const saved = sessionStorage.getItem('sb_token');
    const user  = sessionStorage.getItem('sb_user');
    if (saved && user) {
      state.token = saved;
      state.user  = JSON.parse(user);
      showApp();
      navigate('dashboard');
    } else {
      showLogin();
    }
  }

  // ── Auth ──────────────────────────────────────────────────
  async function login() {
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const btn      = document.getElementById('login-btn');
    const errEl    = document.getElementById('login-error');

    errEl.style.display = 'none';
    if (!email || !password) {
      errEl.textContent = 'Email and password are required.';
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      const data = await apiFetch('/auth/login', 'POST', { email, password }, true);
      state.token = data.token;
      state.user  = data.user;
      sessionStorage.setItem('sb_token', data.token);
      sessionStorage.setItem('sb_user', JSON.stringify(data.user));
      showApp();
      navigate('dashboard');
    } catch (err) {
      errEl.textContent = err.message || 'Login failed. Check credentials.';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  }

  function logout() {
    sessionStorage.clear();
    state.token = null;
    state.user  = null;
    state.cache = {};
    showLogin();
  }

  // ── Shell helpers ─────────────────────────────────────────
  function showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-shell').style.display    = 'none';
  }

  function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-shell').style.display    = 'flex';
    renderUserPill();
    applyRoleVisibility();
  }

  function renderUserPill() {
    const u = state.user;
    if (!u) return;
    document.getElementById('user-name').textContent       = u.name;
    document.getElementById('user-role-badge').textContent = u.role;
    document.getElementById('user-avatar').textContent     = u.name.charAt(0).toUpperCase();
  }

  function applyRoleVisibility() {
    const role = state.user?.role;
    // Hide finance nav for reception
    document.querySelectorAll('.nav-item--finance').forEach(el => {
      el.style.display = (role === 'reception') ? 'none' : '';
    });
    // Hide staff nav for non-owners
    document.querySelectorAll('.nav-item--owner').forEach(el => {
      el.style.display = (role === 'owner') ? '' : 'none';
    });
  }

  // ── Navigation ────────────────────────────────────────────
  function navigate(page) {
    state.currentPage = page;
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.page === page);
    });
    const main = document.getElementById('main-content');
    main.innerHTML = `<div class="page-loading"><div class="spinner"></div><span>Loading…</span></div>`;

    const pages = {
      dashboard: renderDashboard,
      beds:      renderBedMap,
      residents: renderResidents,
      checkin:   renderCheckin,
      payments:  renderPayments,
      finance:   renderFinance,
      staff:     renderStaff,
    };

    const fn = pages[page];
    if (fn) {
      fn().catch(err => {
        main.innerHTML = `<div class="alert alert-error">Failed to load page: ${esc(err.message)}</div>`;
      });
    }
  }

  // ── API fetch ─────────────────────────────────────────────
  async function apiFetch(path, method = 'GET', body = null, noAuth = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (!noAuth && state.token) headers['Authorization'] = `Bearer ${state.token}`;

    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    const res = await fetch(API + path, opts);

    if (res.status === 401) {
      logout();
      throw new Error('Session expired. Please log in again.');
    }

    // Binary responses (CSV/Excel download)
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/csv') || ct.includes('spreadsheetml')) {
      if (!res.ok) throw new Error('Export failed');
      return res.blob();
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ── Toast ─────────────────────────────────────────────────
  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ── Modal ─────────────────────────────────────────────────
  function openModal(html) {
    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('modal-overlay').style.display = 'flex';
  }

  function closeModal(event) {
    if (event && event.target !== document.getElementById('modal-overlay')) return;
    document.getElementById('modal-overlay').style.display = 'none';
    document.getElementById('modal-content').innerHTML = '';
  }

  // ── Escape HTML ───────────────────────────────────────────
  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function rupees(n) {
    const num = parseFloat(n) || 0;
    return '₹' + num.toLocaleString('en-IN');
  }

  function isOwnerOrManager() {
    return state.user?.role === 'owner' || state.user?.role === 'manager';
  }

  // ══════════════════════════════════════════════════════════
  // PAGE: DASHBOARD
  // ══════════════════════════════════════════════════════════
  async function renderDashboard() {
    const data = await apiFetch('/dashboard');
    const main = document.getElementById('main-content');
    const isFinanceUser = isOwnerOrManager();

    const { beds, today, monthly, pending } = data;

    main.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">🏠 Dashboard</h1>
        <span style="color:var(--muted);font-size:13px">${new Date().toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</span>
      </div>

      <!-- Bed stats -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Beds</div>
          <div class="stat-value">${beds.total}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Occupied</div>
          <div class="stat-value" style="color:var(--brand)">${beds.occupied}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Available</div>
          <div class="stat-value green">${beds.available}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Reserved</div>
          <div class="stat-value orange">${beds.reserved}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Cleaning</div>
          <div class="stat-value orange">${beds.cleaning}</div>
        </div>
      </div>

      <!-- Today summary pills -->
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px">
        <div class="pill pill-blue">✅ Check-ins today: <strong>${today.checkins}</strong></div>
        <div class="pill pill-blue">🔑 Check-outs today: <strong>${today.checkouts}</strong></div>
        ${today.overdue_checkouts > 0
          ? `<div class="pill pill-red">⚠️ Overdue checkouts: <strong>${today.overdue_checkouts}</strong></div>`
          : ''}
        ${pending.refunds_awaiting > 0
          ? `<div class="pill pill-orange">🔔 Refunds awaiting approval: <strong>${pending.refunds_awaiting}</strong></div>`
          : ''}
      </div>

      <!-- Financial pills (hidden for reception) -->
      ${isFinanceUser ? `
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px">
        <div class="pill pill-green">💵 Today's collection: <strong>${rupees(today.collection)}</strong></div>
        <div class="pill ${pending.dues_total > 0 ? 'pill-red' : 'pill-green'}">
          ⏳ Pending dues: <strong>${rupees(pending.dues_total)}</strong> (${pending.dues_count} residents)
        </div>
      </div>

      <div class="card" style="max-width:520px">
        <h3 style="margin-bottom:14px;font-size:15px">📅 ${new Date().toLocaleString('en-IN', { month:'long', year:'numeric' })} Summary</h3>
        <div class="report-row">
          <span class="report-label">Total Income</span>
          <span class="report-amount income">${rupees(monthly.income)}</span>
        </div>
        <div class="report-row">
          <span class="report-label">Total Expenses</span>
          <span class="report-amount expense">${rupees(monthly.expenses)}</span>
        </div>
        <div class="report-row">
          <span class="report-label">Net Profit</span>
          <span class="report-amount net">${rupees(monthly.net_profit)}</span>
        </div>
      </div>
      ` : `
      <div class="card" style="max-width:420px">
        <h3 style="margin-bottom:12px;font-size:15px">Your Quick Actions</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="App.navigate('checkin')">✅ New Check-In</button>
          <button class="btn btn-outline" onclick="App.navigate('residents')">👥 View Residents</button>
          <button class="btn btn-outline" onclick="App.navigate('beds')">🛏️ Bed Map</button>
        </div>
      </div>
      `}
    `;
  }

  // ══════════════════════════════════════════════════════════
  // PAGE: BED MAP
  // ══════════════════════════════════════════════════════════
  async function renderBedMap() {
    const data = await apiFetch('/beds');
    const main = document.getElementById('main-content');

    const statusLabel = { available:'Available', occupied:'Occupied', reserved:'Reserved', cleaning:'Cleaning' };

    let floorsHtml = '';
    for (const floor of data.floors) {
      let roomsHtml = '';
      for (const room of floor.rooms) {
        let bedsHtml = room.beds.map(bed => {
          const tooltip = bed.resident_name
            ? `${bed.resident_name}`
            : statusLabel[bed.status];
          return `<button class="bed-chip ${esc(bed.status)}"
            title="${esc(tooltip)}"
            onclick="App.showBedDetail('${esc(bed.id)}', '${esc(bed.status)}', '${esc(bed.resident_name || '')}', '${esc(room.room_number)}', '${esc(bed.bed_label)}')"
          >${esc(bed.bed_label)}</button>`;
        }).join('');

        roomsHtml += `
          <div class="room-block">
            <div class="room-label">Room ${esc(room.room_number)}</div>
            <div class="beds-row">${bedsHtml}</div>
          </div>`;
      }

      floorsHtml += `
        <div class="floor-section card">
          <div class="floor-label">${esc(floor.label)}</div>
          <div class="rooms-row">${roomsHtml}</div>
        </div>`;
    }

    main.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">🛏️ Bed Map</h1>
        <button class="btn btn-primary btn-sm" onclick="App.navigate('beds')">🔄 Refresh</button>
      </div>

      <div class="stats-grid" style="max-width:600px;margin-bottom:18px">
        <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value">${data.summary.total}</div></div>
        <div class="stat-card"><div class="stat-label">Occupied</div><div class="stat-value" style="color:var(--brand)">${data.summary.occupied}</div></div>
        <div class="stat-card"><div class="stat-label">Available</div><div class="stat-value green">${data.summary.available}</div></div>
        <div class="stat-card"><div class="stat-label">Reserved</div><div class="stat-value orange">${data.summary.reserved}</div></div>
        <div class="stat-card"><div class="stat-label">Cleaning</div><div class="stat-value orange">${data.summary.cleaning}</div></div>
      </div>

      <div class="legend">
        <div class="legend-item"><div class="legend-dot" style="background:#dcfce7;border:1px solid #15803d"></div> Available</div>
        <div class="legend-item"><div class="legend-dot" style="background:#dbeafe;border:1px solid #1d4ed8"></div> Occupied</div>
        <div class="legend-item"><div class="legend-dot" style="background:#fef3c7;border:1px solid #b45309"></div> Reserved</div>
        <div class="legend-item"><div class="legend-dot" style="background:#fed7aa;border:1px solid #9a3412"></div> Cleaning</div>
      </div>

      <div class="bed-map">${floorsHtml}</div>
    `;
  }

  function showBedDetail(bedId, status, residentName, roomNumber, bedLabel) {
    const canEdit = state.user?.role !== 'reception' || status !== 'occupied';

    let actions = '';
    if (status === 'cleaning') {
      actions = `<button class="btn btn-primary" onclick="App.setBedStatus('${bedId}','available')">✅ Mark as Available</button>`;
    } else if (status === 'available') {
      actions = `
        <button class="btn btn-primary" onclick="App.navigate('checkin')">✅ Check-In Guest</button>
        <button class="btn btn-outline" onclick="App.setBedStatus('${bedId}','reserved')">🔒 Mark Reserved</button>
      `;
    } else if (status === 'reserved') {
      actions = `
        <button class="btn btn-primary" onclick="App.navigate('checkin')">✅ Check-In Guest</button>
        <button class="btn btn-outline" onclick="App.setBedStatus('${bedId}','available')">🔓 Mark Available</button>
      `;
    } else if (status === 'occupied') {
      actions = residentName
        ? `<button class="btn btn-outline" onclick="App.navigate('residents')">👤 View Resident</button>`
        : '';
    }

    openModal(`
      <div class="modal-title">🛏️ Room ${esc(roomNumber)} — Bed ${esc(bedLabel)}</div>
      <p style="margin-bottom:14px">
        <strong>Status:</strong> <span class="badge badge-${status === 'occupied' ? 'paid' : status === 'available' ? 'paid' : 'partial'}">${status}</span>
        ${residentName ? `<br><strong>Resident:</strong> ${esc(residentName)}` : ''}
      </p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${actions}</div>
    `);
  }

  async function setBedStatus(bedId, status) {
    try {
      await apiFetch(`/beds/${bedId}/status`, 'PUT', { status });
      toast(`Bed marked as ${status}`);
      closeModal();
      navigate('beds');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════
  // PAGE: RESIDENTS
  // ══════════════════════════════════════════════════════════
  async function renderResidents() {
    const main = document.getElementById('main-content');
    main.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">👥 Residents</h1>
        <button class="btn btn-primary btn-sm" onclick="App.navigate('checkin')">+ New Check-In</button>
      </div>
      <div class="search-bar">
        <input id="res-search" type="text" placeholder="Search by name or mobile…" oninput="App.filterResidents()" />
        <select id="res-status-filter" onchange="App.loadResidents()">
          <option value="active">Active</option>
          <option value="checked_out">Checked Out</option>
          <option value="all">All</option>
        </select>
      </div>
      <div class="card">
        <div id="residents-table">
          <div class="page-loading"><div class="spinner"></div></div>
        </div>
      </div>
    `;
    await loadResidents();
  }

  async function loadResidents() {
    const status = document.getElementById('res-status-filter')?.value || 'active';
    try {
      const residents = await apiFetch(`/residents?status=${status}`);
      state.cache.residents = residents;
      renderResidentsTable(residents);
    } catch (err) {
      document.getElementById('residents-table').innerHTML =
        `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  function filterResidents() {
    const q = document.getElementById('res-search')?.value.toLowerCase() || '';
    const filtered = (state.cache.residents || []).filter(r =>
      r.full_name.toLowerCase().includes(q) || r.mobile.includes(q)
    );
    renderResidentsTable(filtered);
  }

  function renderResidentsTable(residents) {
    const container = document.getElementById('residents-table');
    if (!container) return;

    if (!residents.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><p>No residents found.</p></div>`;
      return;
    }

    const isFinance = isOwnerOrManager();

    const rows = residents.map(r => `
      <tr>
        <td>
          <strong>${esc(r.full_name)}</strong><br>
          <span style="color:var(--muted);font-size:12px">${esc(r.mobile)}</span>
        </td>
        <td>${r.floor_label ? `${esc(r.floor_label)} · Room ${esc(r.room_number)} · Bed ${esc(r.bed_label)}` : '—'}</td>
        <td>${r.check_in_date || '—'}</td>
        <td>${r.expected_checkout || '—'}</td>
        ${isFinance ? `
          <td>${rupees(r.monthly_rent)}</td>
          <td><span class="badge badge-${r.payment_badge}">${r.payment_badge}</span></td>
        ` : ''}
        <td>
          <button class="btn btn-outline btn-sm" onclick="App.showResidentDetail('${esc(r.id)}')">View</button>
          ${r.status === 'active' ? `
            <button class="btn btn-warning btn-sm" style="margin-left:4px" onclick="App.showCheckoutModal('${esc(r.id)}','${esc(r.full_name)}')">Check Out</button>
            <button class="btn btn-outline btn-sm" style="margin-left:4px" onclick="App.showExtendModal('${esc(r.id)}','${esc(r.full_name)}','${esc(r.expected_checkout)}','${r.rent_amount}')">Extend</button>
          ` : ''}
        </td>
      </tr>
    `).join('');

    container.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Resident</th>
              <th>Bed</th>
              <th>Check-In</th>
              <th>Expected Out</th>
              ${isFinance ? '<th>Rent</th><th>Payment</th>' : ''}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  async function showResidentDetail(residentId) {
    try {
      const data = await apiFetch(`/residents/${residentId}`);
      const r    = data;
      const isFinance = isOwnerOrManager();

      const payRows = (r.payments || []).map(p => `
        <tr>
          <td>${p.paid_at?.substring(0, 10) || '—'}</td>
          <td>${esc(p.payment_type)}</td>
          <td>${rupees(p.amount)}</td>
          <td>${esc(p.payment_mode)}</td>
          <td>${p.direction === 'credit' ? '📥 In' : '📤 Out'}</td>
          <td>${p.gateway_txn_id ? `<span style="font-family:monospace;font-size:11px">${esc(p.gateway_txn_id)}</span>` : '—'}</td>
        </tr>
      `).join('');

      openModal(`
        <div class="modal-title">👤 ${esc(r.full_name)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;margin-bottom:16px;font-size:13px">
          <div><strong>Mobile:</strong> ${esc(r.mobile)}</div>
          <div><strong>Bed:</strong> ${r.floor_label ? `${esc(r.floor_label)} · ${esc(r.room_number)} · ${esc(r.bed_label)}` : '—'}</div>
          <div><strong>Check-In:</strong> ${r.check_in_date || '—'}</div>
          <div><strong>Expected Out:</strong> ${r.expected_checkout || '—'}</div>
          <div><strong>Coming From:</strong> ${esc(r.coming_from || '—')}</div>
          <div><strong>Purpose:</strong> ${esc(r.purpose_of_visit || '—')}</div>
          <div><strong>Aadhaar:</strong> ${esc(r.aadhaar_number_encrypted || 'XXXX XXXX XXXX')}</div>
          <div><strong>ID Consent:</strong> ${r.id_consent_given ? '✅ Yes' : '❌ No'}</div>
          ${isFinance ? `
          <div><strong>Rent:</strong> ${rupees(r.rent_amount)}</div>
          <div><strong>Deposit:</strong> ${rupees(r.deposit_amount)}</div>
          ` : ''}
        </div>
        ${isFinance && r.payments?.length ? `
          <h4 style="margin-bottom:10px">Payment Ledger</h4>
          <div class="table-wrap" style="max-height:220px;overflow-y:auto">
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Mode</th><th>Dir.</th><th>TxnID</th></tr></thead>
              <tbody>${payRows}</tbody>
            </table>
          </div>
        ` : ''}
        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
          ${r.status === 'active' ? `
            <button class="btn btn-primary btn-sm" onclick="App.showAddPaymentModal('${esc(r.id)}','${esc(r.full_name)}')">+ Record Payment</button>
            <button class="btn btn-warning btn-sm" onclick="App.showCheckoutModal('${esc(r.id)}','${esc(r.full_name)}')">Check Out</button>
          ` : '<span class="badge badge-reception">Checked Out</span>'}
        </div>
      `);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function showCheckoutModal(residentId, name) {
    openModal(`
      <div class="modal-title">🔑 Check-Out: ${esc(name)}</div>
      <div class="form-group">
        <label>Checkout Date *</label>
        <input type="date" id="co-date" value="${new Date().toISOString().substring(0,10)}" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Extra Charges (₹)</label>
          <input type="number" id="co-extra" value="0" min="0" />
        </div>
        <div class="form-group">
          <label>Extra Charges Note</label>
          <input type="text" id="co-extra-note" placeholder="Damage, late fee…" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Deposit Refund Amount (₹)</label>
          <input type="number" id="co-refund" value="0" min="0" />
        </div>
        <div class="form-group">
          <label>Payment Mode</label>
          <select id="co-mode">
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Gateway Transaction ID</label>
        <input type="text" id="co-txn" placeholder="pay_xxxxx (if UPI/card)" />
      </div>
      <div class="approval-banner">
        🔔 Deposit refunds above ₹0 will require Owner/Manager approval before settlement.
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea id="co-notes" rows="2"></textarea>
      </div>
      <button class="btn btn-danger btn-full" onclick="App.submitCheckout('${esc(residentId)}')">Confirm Check-Out</button>
    `);
  }

  async function submitCheckout(residentId) {
    const payload = {
      checkout_date:       document.getElementById('co-date').value,
      extra_charges:       parseFloat(document.getElementById('co-extra').value) || 0,
      extra_charges_note:  document.getElementById('co-extra-note').value,
      deposit_refund_amount: parseFloat(document.getElementById('co-refund').value) || 0,
      payment_mode:        document.getElementById('co-mode').value,
      gateway_txn_id:      document.getElementById('co-txn').value || null,
      notes:               document.getElementById('co-notes').value,
    };

    if (!payload.checkout_date) {
      toast('Checkout date is required', 'error'); return;
    }

    try {
      const res = await apiFetch(`/checkout/${residentId}`, 'POST', payload);
      toast(res.refund_pending_approval
        ? 'Check-out recorded. Refund awaiting approval.'
        : 'Check-out completed successfully.');
      closeModal();
      navigate('residents');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function showExtendModal(residentId, name, currentCheckout, currentRent) {
    openModal(`
      <div class="modal-title">📅 Extend Stay: ${esc(name)}</div>
      <p style="color:var(--muted);margin-bottom:14px;font-size:13px">Current expected checkout: <strong>${esc(currentCheckout)}</strong></p>
      <div class="form-group">
        <label>New Expected Checkout *</label>
        <input type="date" id="ext-date" value="${currentCheckout}" />
      </div>
      <div class="form-group">
        <label>New Monthly Rent (₹) — leave blank to keep current (${rupees(currentRent)})</label>
        <input type="number" id="ext-rent" placeholder="${currentRent}" min="0" />
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea id="ext-notes" rows="2"></textarea>
      </div>
      <button class="btn btn-primary btn-full" onclick="App.submitExtend('${esc(residentId)}')">Extend Stay</button>
    `);
  }

  async function submitExtend(residentId) {
    const newDate = document.getElementById('ext-date').value;
    const newRent = document.getElementById('ext-rent').value;
    const notes   = document.getElementById('ext-notes').value;

    if (!newDate) { toast('New checkout date is required', 'error'); return; }

    try {
      await apiFetch(`/residents/${residentId}/extend`, 'POST', {
        new_expected_checkout: newDate,
        new_rent_amount: newRent ? parseFloat(newRent) : undefined,
        notes,
      });
      toast('Stay extended successfully');
      closeModal();
      navigate('residents');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════
  // PAGE: CHECK-IN
  // ══════════════════════════════════════════════════════════
  async function renderCheckin() {
    const availBeds = await apiFetch('/beds/available');
    const main = document.getElementById('main-content');

    const bedOptions = availBeds.map(b =>
      `<option value="${esc(b.id)}">${esc(b.display_label)}</option>`
    ).join('');

    const today = new Date().toISOString().substring(0, 10);
    const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().substring(0, 10);

    main.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">✅ New Check-In</h1>
      </div>

      <div class="card" style="max-width:660px">
        <h3 style="margin-bottom:18px;font-size:15px">Guest Information</h3>

        <div class="form-row">
          <div class="form-group">
            <label>Full Name *</label>
            <input type="text" id="ci-name" placeholder="Ramesh Kumar" />
          </div>
          <div class="form-group">
            <label>Mobile *</label>
            <input type="tel" id="ci-mobile" placeholder="98XXXXXXXX" maxlength="10" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Coming From</label>
            <input type="text" id="ci-from" placeholder="Nashik, Maharashtra" />
          </div>
          <div class="form-group">
            <label>Purpose of Visit</label>
            <input type="text" id="ci-purpose" placeholder="Job / Work / Studies" />
          </div>
        </div>

        <div class="form-group">
          <label>Permanent Address</label>
          <textarea id="ci-address" rows="2" placeholder="Full address"></textarea>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Emergency Contact Name</label>
            <input type="text" id="ci-ec-name" />
          </div>
          <div class="form-group">
            <label>Emergency Contact Mobile</label>
            <input type="tel" id="ci-ec-mobile" maxlength="10" />
          </div>
        </div>

        <h3 style="margin:18px 0 14px;font-size:15px">Identity Document (Aadhaar)</h3>

        <div class="form-row">
          <div class="form-group">
            <label>Aadhaar Number</label>
            <input type="text" id="ci-aadhaar" placeholder="XXXX XXXX XXXX" maxlength="14"
              oninput="this.value=this.value.replace(/[^0-9 ]/g,'')" />
          </div>
          <div class="form-group">
            <label>Aadhaar-Linked Mobile</label>
            <input type="tel" id="ci-aadhaar-mobile" placeholder="98XXXXXXXX" maxlength="10" />
          </div>
        </div>

        <div class="consent-row">
          <input type="checkbox" id="ci-consent" />
          <label for="ci-consent">
            ☑ <strong>Guest Consent Captured</strong> — The guest has been informed and has consented
            to storage of their identity document for the purpose of property verification,
            as required under applicable law.
          </label>
        </div>

        <h3 style="margin:18px 0 14px;font-size:15px">Bed & Stay Details</h3>

        <div class="form-row">
          <div class="form-group">
            <label>Bed *</label>
            <select id="ci-bed">
              <option value="">— Select available bed —</option>
              ${bedOptions}
            </select>
          </div>
          <div class="form-group">
            <label>Check-In Date *</label>
            <input type="date" id="ci-checkin" value="${today}" />
          </div>
        </div>

        <div class="form-group">
          <label>Expected Checkout Date *</label>
          <input type="date" id="ci-checkout" value="${nextMonth}" />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Monthly Rent (₹) *</label>
            <input type="number" id="ci-rent" placeholder="6000" min="0" />
          </div>
          <div class="form-group">
            <label>Security Deposit (₹)</label>
            <input type="number" id="ci-deposit" placeholder="5000" min="0" value="0" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Amount Paid Now (₹)</label>
            <input type="number" id="ci-paid" placeholder="0" min="0" value="0" />
          </div>
          <div class="form-group">
            <label>Payment Mode</label>
            <div class="mode-group">
              <div class="mode-btn active" onclick="App.setPayMode(this,'cash')">Cash</div>
              <div class="mode-btn" onclick="App.setPayMode(this,'upi')">UPI</div>
              <div class="mode-btn" onclick="App.setPayMode(this,'card')">Card</div>
            </div>
            <input type="hidden" id="ci-mode" value="cash" />
          </div>
        </div>

        <div class="form-group">
          <label>Gateway Transaction ID (if UPI/card)</label>
          <input type="text" id="ci-txn" placeholder="pay_xxxxx" />
        </div>

        <div class="form-group">
          <label>Notes</label>
          <textarea id="ci-notes" rows="2"></textarea>
        </div>

        <div id="ci-error" class="alert alert-error" style="display:none"></div>
        <button class="btn btn-primary btn-full" style="margin-top:8px" onclick="App.submitCheckin()">
          ✅ Confirm Check-In
        </button>
      </div>
    `;
  }

  function setPayMode(el, mode) {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    const hidden = document.getElementById('ci-mode');
    if (hidden) hidden.value = mode;
  }

  async function submitCheckin() {
    const err = document.getElementById('ci-error');
    err.style.display = 'none';

    const consent = document.getElementById('ci-consent')?.checked;
    if (!consent) {
      err.textContent = 'You must capture guest consent for ID storage before proceeding.';
      err.style.display = 'block';
      return;
    }

    const payload = {
      full_name:               document.getElementById('ci-name').value.trim(),
      mobile:                  document.getElementById('ci-mobile').value.trim(),
      coming_from:             document.getElementById('ci-from').value.trim(),
      purpose_of_visit:        document.getElementById('ci-purpose').value.trim(),
      permanent_address:       document.getElementById('ci-address').value.trim(),
      emergency_contact_name:  document.getElementById('ci-ec-name').value.trim(),
      emergency_contact_mobile:document.getElementById('ci-ec-mobile').value.trim(),
      aadhaar_number:          document.getElementById('ci-aadhaar').value.trim(),
      aadhaar_mobile:          document.getElementById('ci-aadhaar-mobile').value.trim(),
      id_consent_given:        true,
      bed_id:                  document.getElementById('ci-bed').value,
      check_in_date:           document.getElementById('ci-checkin').value,
      expected_checkout:       document.getElementById('ci-checkout').value,
      rent_amount:             parseFloat(document.getElementById('ci-rent').value) || 0,
      deposit_amount:          parseFloat(document.getElementById('ci-deposit').value) || 0,
      amount_paid:             parseFloat(document.getElementById('ci-paid').value) || 0,
      payment_mode:            document.getElementById('ci-mode').value,
      gateway_txn_id:          document.getElementById('ci-txn').value || null,
      notes:                   document.getElementById('ci-notes').value,
    };

    // Front-end validation
    if (!payload.full_name)       { err.textContent = 'Full name is required.'; err.style.display='block'; return; }
    if (!payload.mobile)          { err.textContent = 'Mobile number is required.'; err.style.display='block'; return; }
    if (!payload.bed_id)          { err.textContent = 'Please select a bed.'; err.style.display='block'; return; }
    if (!payload.check_in_date)   { err.textContent = 'Check-in date is required.'; err.style.display='block'; return; }
    if (!payload.expected_checkout){ err.textContent = 'Expected checkout date is required.'; err.style.display='block'; return; }
    if (!payload.rent_amount)     { err.textContent = 'Monthly rent amount is required.'; err.style.display='block'; return; }

    try {
      await apiFetch('/checkin', 'POST', payload);
      toast('Check-in successful! 🎉');
      navigate('residents');
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
    }
  }

  // ══════════════════════════════════════════════════════════
  // PAGE: PAYMENTS
  // ══════════════════════════════════════════════════════════
  async function renderPayments() {
    const main = document.getElementById('main-content');
    main.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">💰 Payments</h1>
        <button class="btn btn-primary btn-sm" onclick="App.showAddPaymentModal()">+ Record Payment</button>
      </div>
      <div class="tab-bar">
        <button class="tab-btn active" onclick="App.switchPayTab(this,'pending')">Pending Dues</button>
        ${isOwnerOrManager() ? `<button class="tab-btn" onclick="App.switchPayTab(this,'approvals')">Refund Approvals</button>` : ''}
      </div>
      <div id="payments-content">
        <div class="page-loading"><div class="spinner"></div></div>
      </div>
    `;
    await loadPendingDues();
  }

  async function switchPayTab(btn, tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (tab === 'pending')   await loadPendingDues();
    if (tab === 'approvals') await loadPendingApprovals();
  }

  async function loadPendingDues() {
    const container = document.getElementById('payments-content');
    try {
      const data = await apiFetch('/payments/pending');
      if (!data.residents.length) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎉</div><p>All residents are paid up!</p></div>`;
        return;
      }

      const rows = data.residents.map(r => `
        <tr>
          <td><strong>${esc(r.full_name)}</strong><br><span style="color:var(--muted);font-size:12px">${esc(r.mobile)}</span></td>
          <td>${r.floor_label ? `${esc(r.floor_label)} · ${esc(r.room_number)} · ${esc(r.bed_label)}` : '—'}</td>
          <td>${rupees(r.rent_amount)}</td>
          <td>${rupees(r.rent_paid_this_month)}</td>
          <td>${rupees(r.pending_amount)}</td>
          <td><span class="badge badge-${r.payment_status}">${r.payment_status}</span></td>
          <td>
            <button class="btn btn-primary btn-sm"
              onclick="App.showAddPaymentModal('${esc(r.resident_id)}','${esc(r.full_name)}')">
              Record Payment
            </button>
          </td>
        </tr>
      `).join('');

      container.innerHTML = `
        <div class="card" style="margin-bottom:14px">
          <div style="display:flex;gap:16px;font-size:14px">
            <span>📋 <strong>${data.count}</strong> residents with dues</span>
            <span>💰 Total pending: <strong style="color:var(--danger)">${rupees(data.total_pending)}</strong></span>
          </div>
        </div>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Resident</th><th>Bed</th><th>Rent</th><th>Paid</th><th>Pending</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  async function loadPendingApprovals() {
    const container = document.getElementById('payments-content');
    try {
      const approvals = await apiFetch('/payments/pending-approvals');
      if (!approvals.length) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>No refunds awaiting approval.</p></div>`;
        return;
      }

      const rows = approvals.map(p => `
        <tr>
          <td><strong>${esc(p.resident_name)}</strong><br><span style="color:var(--muted);font-size:12px">${esc(p.resident_mobile)}</span></td>
          <td>${rupees(p.amount)}</td>
          <td>${p.paid_at?.substring(0,10) || '—'}</td>
          <td>${esc(p.notes || '—')}</td>
          <td>
            <button class="btn btn-primary btn-sm" onclick="App.decideRefund('${esc(p.id)}','approved')">✅ Approve</button>
            <button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="App.decideRefund('${esc(p.id)}','rejected')">❌ Reject</button>
          </td>
        </tr>
      `).join('');

      container.innerHTML = `
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Resident</th><th>Refund</th><th>Submitted</th><th>Note</th><th>Action</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  async function decideRefund(paymentId, decision) {
    try {
      await apiFetch(`/payments/${paymentId}/approve`, 'POST', { decision });
      toast(`Refund ${decision}`);
      await loadPendingApprovals();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function showAddPaymentModal(residentId, residentName) {
    // Load active residents for dropdown if no residentId provided
    let resOptions = '';
    if (!residentId) {
      const list = await apiFetch('/residents?status=active');
      resOptions = list.map(r =>
        `<option value="${esc(r.id)}">${esc(r.full_name)} — ${esc(r.mobile)}</option>`
      ).join('');
    }

    openModal(`
      <div class="modal-title">💰 Record Payment</div>
      ${residentId
        ? `<p style="margin-bottom:14px;font-weight:600;color:var(--brand)">${esc(residentName)}</p>
           <input type="hidden" id="pay-resident" value="${esc(residentId)}" />`
        : `<div class="form-group">
             <label>Resident *</label>
             <select id="pay-resident">
               <option value="">— Select resident —</option>
               ${resOptions}
             </select>
           </div>`
      }
      <div class="form-row">
        <div class="form-group">
          <label>Payment Type</label>
          <select id="pay-type">
            <option value="rent">Rent</option>
            <option value="deposit">Deposit</option>
            <option value="advance">Advance</option>
            <option value="extra_charge">Extra Charge</option>
          </select>
        </div>
        <div class="form-group">
          <label>Amount (₹) *</label>
          <input type="number" id="pay-amount" placeholder="e.g. 3000" min="1" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Payment Mode</label>
          <select id="pay-mode">
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
            <option value="bank_transfer">Bank Transfer</option>
          </select>
        </div>
        <div class="form-group">
          <label>Billing Month (YYYY-MM)</label>
          <input type="month" id="pay-month" value="${new Date().toISOString().substring(0,7)}" />
        </div>
      </div>
      <div class="form-group">
        <label>Gateway Transaction ID (optional)</label>
        <input type="text" id="pay-txn" placeholder="pay_xxxxx" />
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea id="pay-notes" rows="2"></textarea>
      </div>
      <button class="btn btn-primary btn-full" onclick="App.submitPayment()">Record Payment</button>
    `);
  }

  async function submitPayment() {
    const residentId = document.getElementById('pay-resident')?.value;
    const amount     = document.getElementById('pay-amount')?.value;

    if (!residentId || !amount) {
      toast('Resident and amount are required', 'error'); return;
    }

    try {
      await apiFetch('/payments', 'POST', {
        resident_id:    residentId,
        payment_type:   document.getElementById('pay-type').value,
        amount:         parseFloat(amount),
        payment_mode:   document.getElementById('pay-mode').value,
        billing_month:  document.getElementById('pay-month').value,
        gateway_txn_id: document.getElementById('pay-txn').value || null,
        notes:          document.getElementById('pay-notes').value,
      });
      toast('Payment recorded ✅');
      closeModal();
      navigate('payments');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════
  // PAGE: FINANCE REPORTS
  // ══════════════════════════════════════════════════════════
  async function renderFinance() {
    if (!isOwnerOrManager()) {
      document.getElementById('main-content').innerHTML =
        `<div class="alert alert-error">Access restricted. Manager or Owner role required.</div>`;
      return;
    }

    const main = document.getElementById('main-content');
    main.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">📈 Financial Reports</h1>
      </div>
      <div class="tab-bar">
        <button class="tab-btn active" onclick="App.switchFinanceTab(this,'report')">P&amp;L Report</button>
        <button class="tab-btn" onclick="App.switchFinanceTab(this,'expenses')">Expenses</button>
        <button class="tab-btn" onclick="App.switchFinanceTab(this,'audit')">Audit Trail</button>
      </div>
      <div id="finance-content">
        <div class="page-loading"><div class="spinner"></div></div>
      </div>
    `;
    await loadFinanceReport('monthly');
  }

  async function switchFinanceTab(btn, tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (tab === 'report')   await loadFinanceReport('monthly');
    if (tab === 'expenses') await loadExpenses();
    if (tab === 'audit')    await loadAuditLog();
  }

  async function loadFinanceReport(period) {
    const container = document.getElementById('finance-content');
    try {
      const data = await apiFetch(`/finance/report?period=${period}`);

      const dailyRows = data.daily_breakdown.map(d => `
        <tr>
          <td>${d.day}</td>
          <td style="color:var(--success)">${rupees(d.income)}</td>
          <td style="color:var(--danger)">${rupees(d.refunds)}</td>
        </tr>
      `).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--muted)">No data</td></tr>';

      container.innerHTML = `
        <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap">
          ${['daily','weekly','monthly','yearly'].map(p =>
            `<button class="btn ${period===p ? 'btn-primary' : 'btn-outline'} btn-sm"
              onclick="App.loadFinanceReport('${p}')">${p.charAt(0).toUpperCase()+p.slice(1)}</button>`
          ).join('')}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:700px;margin-bottom:18px">
          <div class="card">
            <h4 style="margin-bottom:12px;font-size:14px">Income</h4>
            <div class="report-row"><span class="report-label">Rent</span><span class="report-amount income">${rupees(data.income.rent)}</span></div>
            <div class="report-row"><span class="report-label">Deposits</span><span class="report-amount income">${rupees(data.income.deposits)}</span></div>
            <div class="report-row"><span class="report-label">Extras</span><span class="report-amount income">${rupees(data.income.extras)}</span></div>
            <div class="report-row" style="border-top:2px solid var(--border);margin-top:4px;padding-top:12px">
              <span class="report-label"><strong>Total Income</strong></span>
              <span class="report-amount income"><strong>${rupees(data.income.total)}</strong></span>
            </div>
          </div>

          <div class="card">
            <h4 style="margin-bottom:12px;font-size:14px">Outflow</h4>
            <div class="report-row"><span class="report-label">Expenses</span><span class="report-amount expense">${rupees(data.expenses.total)}</span></div>
            <div class="report-row"><span class="report-label">Refunds Paid</span><span class="report-amount expense">${rupees(data.refunds)}</span></div>
            <div class="report-row" style="border-top:2px solid var(--border);margin-top:4px;padding-top:12px">
              <span class="report-label"><strong>Net Profit</strong></span>
              <span class="report-amount net"><strong>${rupees(data.net_profit)}</strong></span>
            </div>
          </div>
        </div>

        <div class="card" style="max-width:700px;margin-bottom:16px">
          <h4 style="margin-bottom:12px;font-size:14px">Expenses by Category</h4>
          ${data.expenses.by_category.map(c => `
            <div class="report-row">
              <span class="report-label">${esc(c.category)}</span>
              <span class="report-amount expense">${rupees(c.cat_total)}</span>
            </div>
          `).join('') || '<p style="color:var(--muted)">No expenses recorded.</p>'}
        </div>

        <div class="card" style="max-width:480px;margin-bottom:16px">
          <h4 style="margin-bottom:12px;font-size:14px">Daily Breakdown</h4>
          <div class="table-wrap" style="max-height:260px;overflow-y:auto">
            <table>
              <thead><tr><th>Date</th><th>Income</th><th>Refunds</th></tr></thead>
              <tbody>${dailyRows}</tbody>
            </table>
          </div>
        </div>

        <div class="export-row">
          <span style="color:var(--muted);font-size:13px">Export (${period}):</span>
          <button class="btn btn-outline btn-sm" onclick="App.downloadReport('${period}','csv')">📄 CSV</button>
          <button class="btn btn-outline btn-sm" onclick="App.downloadReport('${period}','excel')">📊 Excel</button>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  async function downloadReport(period, format) {
    try {
      const blob = await apiFetch(`/finance/export?period=${period}&format=${format}`);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `sthappit-report-${period}.${format === 'excel' ? 'xlsx' : 'csv'}`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Report downloaded');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadExpenses() {
    const container = document.getElementById('finance-content');
    try {
      const expenses = await apiFetch('/expenses');

      const rows = expenses.map(e => `
        <tr>
          <td>${e.expense_date}</td>
          <td>${esc(e.category)}</td>
          <td>${esc(e.description || '—')}</td>
          <td>${rupees(e.amount)}</td>
          <td>${esc(e.payment_mode)}</td>
        </tr>
      `).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">No expenses recorded.</td></tr>';

      container.innerHTML = `
        <div style="margin-bottom:14px;display:flex;justify-content:flex-end">
          <button class="btn btn-primary btn-sm" onclick="App.showAddExpenseModal()">+ Add Expense</button>
        </div>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Mode</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  function showAddExpenseModal() {
    openModal(`
      <div class="modal-title">➕ Add Expense</div>
      <div class="form-row">
        <div class="form-group">
          <label>Category *</label>
          <select id="exp-cat">
            <option>Electricity</option>
            <option>Water</option>
            <option>Internet</option>
            <option>Housekeeping</option>
            <option>Maintenance</option>
            <option>Security</option>
            <option>Salary</option>
            <option>Miscellaneous</option>
          </select>
        </div>
        <div class="form-group">
          <label>Amount (₹) *</label>
          <input type="number" id="exp-amount" placeholder="1000" min="1" />
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Date *</label>
          <input type="date" id="exp-date" value="${new Date().toISOString().substring(0,10)}" />
        </div>
        <div class="form-group">
          <label>Payment Mode</label>
          <select id="exp-mode">
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
            <option value="bank_transfer">Bank Transfer</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Description</label>
        <input type="text" id="exp-desc" placeholder="Brief note" />
      </div>
      <button class="btn btn-primary btn-full" onclick="App.submitExpense()">Save Expense</button>
    `);
  }

  async function submitExpense() {
    const amount = document.getElementById('exp-amount').value;
    const date   = document.getElementById('exp-date').value;
    if (!amount || !date) { toast('Amount and date are required', 'error'); return; }

    try {
      await apiFetch('/expenses', 'POST', {
        category:     document.getElementById('exp-cat').value,
        amount:       parseFloat(amount),
        expense_date: date,
        payment_mode: document.getElementById('exp-mode').value,
        description:  document.getElementById('exp-desc').value,
      });
      toast('Expense recorded');
      closeModal();
      await loadExpenses();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadAuditLog() {
    const container = document.getElementById('finance-content');
    try {
      const data = await apiFetch('/finance/audit?limit=80');
      const rows = data.rows.map(a => `
        <tr>
          <td style="font-size:11px;color:var(--muted)">${a.created_at?.substring(0,16)}</td>
          <td>${esc(a.user_name)}<br><span style="font-size:11px;color:var(--muted)">${esc(a.user_role)}</span></td>
          <td><code style="font-size:11px;background:var(--bg);padding:2px 5px;border-radius:4px">${esc(a.action)}</code></td>
          <td>${esc(a.entity_type)} / <span style="font-family:monospace;font-size:11px">${esc(a.entity_id?.substring(0,8))}…</span></td>
        </tr>
      `).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">No audit entries.</td></tr>';

      container.innerHTML = `
        <div class="card">
          <p style="color:var(--muted);font-size:13px;margin-bottom:12px">Showing last ${data.rows.length} of ${data.total} entries. All money-touching actions are logged.</p>
          <div class="table-wrap" style="max-height:420px;overflow-y:auto">
            <table>
              <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  // ══════════════════════════════════════════════════════════
  // PAGE: STAFF MANAGEMENT
  // ══════════════════════════════════════════════════════════
  async function renderStaff() {
    if (state.user?.role !== 'owner') {
      document.getElementById('main-content').innerHTML =
        `<div class="alert alert-error">Access restricted. Owner role required.</div>`;
      return;
    }

    const main = document.getElementById('main-content');
    main.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">👤 Staff & Roles</h1>
        <button class="btn btn-primary btn-sm" onclick="App.showAddStaffModal()">+ Add Staff</button>
      </div>
      <div id="staff-content">
        <div class="page-loading"><div class="spinner"></div></div>
      </div>
    `;
    await loadStaff();
  }

  async function loadStaff() {
    const container = document.getElementById('staff-content');
    try {
      const staff = await apiFetch('/staff');

      const roleDesc = {
        owner:     'Full access — property, financials, staff',
        manager:   'Residents, beds, payments, expenses, reports',
        reception: 'Check-in / out, resident info, payment entry only',
      };

      const rows = staff.map(u => `
        <tr>
          <td>
            <strong>${esc(u.name)}</strong><br>
            <span style="color:var(--muted);font-size:12px">${esc(u.email || u.mobile)}</span>
          </td>
          <td><span class="badge badge-${esc(u.role)}">${esc(u.role)}</span></td>
          <td style="font-size:12px;color:var(--muted)">${esc(roleDesc[u.role] || '')}</td>
          <td>${u.is_active ? '<span style="color:var(--success)">Active</span>' : '<span style="color:var(--danger)">Inactive</span>'}</td>
          <td>
            ${u.id !== state.user.id ? `
              <button class="btn btn-outline btn-sm" onclick="App.showEditStaffModal('${esc(u.id)}','${esc(u.name)}','${esc(u.role)}')">Edit</button>
              ${u.is_active ? `<button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="App.deactivateStaff('${esc(u.id)}','${esc(u.name)}')">Deactivate</button>` : ''}
            ` : '<span style="color:var(--muted);font-size:12px">You</span>'}
          </td>
        </tr>
      `).join('');

      const permMatrix = `
        <div class="card" style="margin-top:20px;max-width:600px">
          <h4 style="margin-bottom:14px">Permission Matrix</h4>
          <table>
            <thead><tr><th>Feature</th><th>Owner</th><th>Manager</th><th>Reception</th></tr></thead>
            <tbody>
              <tr><td>Bed Map</td><td>✅</td><td>✅</td><td>✅</td></tr>
              <tr><td>Check-In / Out</td><td>✅</td><td>✅</td><td>✅</td></tr>
              <tr><td>Record Payments</td><td>✅</td><td>✅</td><td>✅</td></tr>
              <tr><td>Revenue &amp; Reports</td><td>✅</td><td>✅</td><td>❌</td></tr>
              <tr><td>Add Expenses</td><td>✅</td><td>✅</td><td>❌</td></tr>
              <tr><td>Approve Refunds</td><td>✅</td><td>✅</td><td>❌</td></tr>
              <tr><td>Extend Stay</td><td>✅</td><td>✅</td><td>❌</td></tr>
              <tr><td>Staff Management</td><td>✅</td><td>❌</td><td>❌</td></tr>
              <tr><td>Audit Log</td><td>✅</td><td>✅</td><td>❌</td></tr>
            </tbody>
          </table>
        </div>
      `;

      container.innerHTML = `
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Role</th><th>Access Level</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
        ${permMatrix}
      `;
    } catch (err) {
      container.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  function showAddStaffModal() {
    openModal(`
      <div class="modal-title">➕ Add Staff Member</div>
      <div class="form-row">
        <div class="form-group">
          <label>Full Name *</label>
          <input type="text" id="st-name" placeholder="Priya Desai" />
        </div>
        <div class="form-group">
          <label>Mobile *</label>
          <input type="tel" id="st-mobile" placeholder="98XXXXXXXX" maxlength="10" />
        </div>
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="st-email" placeholder="priya@example.com" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Role *</label>
          <select id="st-role">
            <option value="reception">Reception / Cashier</option>
            <option value="manager">Manager</option>
          </select>
        </div>
        <div class="form-group">
          <label>Password *</label>
          <input type="password" id="st-pass" placeholder="Min 8 characters" />
        </div>
      </div>
      <button class="btn btn-primary btn-full" onclick="App.submitAddStaff()">Add Staff Member</button>
    `);
  }

  async function submitAddStaff() {
    const name     = document.getElementById('st-name').value.trim();
    const mobile   = document.getElementById('st-mobile').value.trim();
    const email    = document.getElementById('st-email').value.trim();
    const role     = document.getElementById('st-role').value;
    const password = document.getElementById('st-pass').value;

    if (!name || !mobile || !password || !role) {
      toast('Name, mobile, role and password are required', 'error'); return;
    }

    try {
      await apiFetch('/staff', 'POST', { name, mobile, email: email || undefined, role, password });
      toast('Staff member added');
      closeModal();
      await loadStaff();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function showEditStaffModal(userId, name, role) {
    openModal(`
      <div class="modal-title">✏️ Edit: ${esc(name)}</div>
      <div class="form-group">
        <label>Role</label>
        <select id="edit-role">
          <option value="reception" ${role==='reception'?'selected':''}>Reception / Cashier</option>
          <option value="manager" ${role==='manager'?'selected':''}>Manager</option>
        </select>
      </div>
      <button class="btn btn-primary btn-full" onclick="App.submitEditStaff('${esc(userId)}')">Save Changes</button>
    `);
  }

  async function submitEditStaff(userId) {
    const role = document.getElementById('edit-role').value;
    try {
      await apiFetch(`/staff/${userId}`, 'PUT', { role });
      toast('Staff updated');
      closeModal();
      await loadStaff();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deactivateStaff(userId, name) {
    if (!confirm(`Deactivate ${name}? They will no longer be able to log in.`)) return;
    try {
      await apiFetch(`/staff/${userId}`, 'DELETE');
      toast(`${name} deactivated`);
      await loadStaff();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ── Expose public API ─────────────────────────────────────
  return {
    init,
    login,
    logout,
    navigate,
    closeModal,

    // Bed map
    showBedDetail,
    setBedStatus,

    // Residents
    filterResidents,
    loadResidents,
    showResidentDetail,
    showCheckoutModal,
    submitCheckout,
    showExtendModal,
    submitExtend,

    // Check-in
    submitCheckin,
    setPayMode,

    // Payments
    switchPayTab,
    showAddPaymentModal,
    submitPayment,
    decideRefund,

    // Finance
    switchFinanceTab,
    loadFinanceReport,
    downloadReport,
    showAddExpenseModal,
    submitExpense,

    // Staff
    showAddStaffModal,
    submitAddStaff,
    showEditStaffModal,
    submitEditStaff,
    deactivateStaff,
  };

})();

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
