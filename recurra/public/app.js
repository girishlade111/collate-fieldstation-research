const $ = (s) => document.querySelector(s);
const api = async (p, o = {}) => {
  const r = await fetch(p, { headers: { 'content-type': 'application/json' }, ...o });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
};
const fmt = (n, code = state.mainCode, sym = state.mainSym) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(n); }
  catch { return `${sym || code || ''} ${Number(n).toFixed(2)}`; }
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  subs: [], cats: [], mems: [], pays: [], curs: [], settings: {},
  mainCode: 'USD', mainSym: '$', view: 'list',
  calY: new Date().getFullYear(), calM: new Date().getMonth() + 1,
};

// ---------- tabs / theme ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  $('#tab-' + b.dataset.tab).classList.add('active');
  if (b.dataset.tab === 'calendar') loadCalendar();
  if (b.dataset.tab === 'stats') loadStats();
}));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => document.querySelector(`[data-tab="${b.dataset.goto}"]`).click()));
$('#themeBtn').addEventListener('click', () => {
  const h = document.documentElement;
  h.dataset.theme = h.dataset.theme === 'light' ? 'dark' : 'light';
  $('#themeBtn').textContent = h.dataset.theme === 'light' ? '🌙' : '☀️';
});

// ---------- loaders ----------
async function refreshAll() {
  const [settings, cats, mems, pays, curs] = await Promise.all([
    api('/api/settings'), api('/api/categories'), api('/api/members'), api('/api/payment-methods'), api('/api/currencies'),
  ]);
  state.settings = settings; state.cats = cats; state.mems = mems; state.pays = pays; state.curs = curs;
  const main = curs.find((c) => c.id === settings.main_currency_id) || curs.find((c) => c.is_main) || curs[0];
  state.mainCode = main?.code || 'USD'; state.mainSym = main?.symbol || '$';
  fillManage(); fillFilters(); fillSubOptions();
  await Promise.all([loadOverview(), loadSubs(), loadReminders()]);
}
function fillFilters() {
  const c = $('#fCat'); c.innerHTML = '<option value="">All categories</option>' + state.cats.map((x) => `<option value="${x.id}">${esc(x.icon)} ${esc(x.name)}</option>`).join('');
  const m = $('#fMem'); m.innerHTML = '<option value="">All members</option>' + state.mems.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
}
function fillSubOptions() {
  $('#fCurrency').innerHTML = state.curs.map((x) => `<option value="${x.id}">${esc(x.code)} — ${esc(x.name)}</option>`).join('');
  $('#fCategory').innerHTML = state.cats.map((x) => `<option value="${x.id}">${esc(x.icon)} ${esc(x.name)}</option>`).join('');
  $('#fMember').innerHTML = state.mems.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  $('#fPay').innerHTML = state.pays.map((x) => `<option value="${x.id}">${esc(x.icon)} ${esc(x.name)}</option>`).join('');
}

async function loadOverview() {
  const o = await api('/api/overview');
  state.mainCode = o.main_currency?.code || state.mainCode;
  $('#kpis').innerHTML = [
    ['Active', o.counts.active], ['Monthly cost', fmt(o.costs.monthly)], ['Yearly cost', fmt(o.costs.yearly)],
    ['Due this month', fmt(o.costs.due_this_month)], ['Inactive savings/mo', fmt(o.costs.savings_monthly)],
  ].map(([k, v]) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  $('#overdueWrap').innerHTML = o.overdue.length ? `<div class="card" style="border-color:var(--danger)"><h2>⚠️ Overdue manual renewals (${o.overdue.length})</h2>${o.overdue.map((s) => rowMini(s)).join('')}</div>` : '';
  $('#upcoming').innerHTML = o.upcoming.length ? o.upcoming.map((s) => rowMini(s)).join('') : '<p class="muted">Nothing upcoming. 🎉</p>';
  const b = o.budget;
  $('#budgetLabel').textContent = b.monthly > 0 ? `${fmt(o.costs.monthly)} of ${fmt(b.monthly)}` : 'No budget set — add one in Manage';
  $('#budgetBar').style.width = (b.monthly > 0 ? Math.min(100, b.used_pct) : 0) + '%';
  $('#budgetBar').style.background = b.over > 0 ? 'var(--danger)' : 'var(--brand)';
  $('#budgetText').textContent = b.monthly > 0 ? `${b.used_pct}% used · ${fmt(b.left)} left${b.over > 0 ? ` · over by ${fmt(b.over)}` : ''}` : `Current normalised spend is ${fmt(o.costs.monthly)} / month.`;
  const cal = await api(`/api/calendar?year=${state.calY}&month=${state.calM}`);
  $('#peekCal').innerHTML = Object.keys(cal.days).sort((a, b) => a - b).slice(0, 6).map((d) => {
    const items = cal.days[d];
    const tot = items.reduce((a, s) => a + s.converted_price, 0);
    return `<div class="pitem"><span>Day ${d} · ${items.slice(0, 3).map((s) => esc(s.name)).join(', ')}${items.length > 3 ? ` +${items.length - 3}` : ''}</span><b>${fmt(tot)}</b></div>`;
  }).join('') || '<p class="muted">No charges this month.</p>';
}
const rowMini = (s) => `<div class="pitem"><span>${esc(s.emoji)} <b>${esc(s.name)}</b> <span class="muted">· ${esc(s.next_payment)} · ${esc(s.billing_label)}</span></span><b>${fmt(s.converted_price)}${s.currency.code !== state.mainCode ? ` <small class="muted">${esc(s.price)} ${esc(s.currency.code)}</small>` : ''}</b></div>`;

// ---------- subscriptions list ----------
async function loadSubs() {
  const q = new URLSearchParams({
    search: $('#search').value, category: $('#fCat').value, member: $('#fMem').value,
    state: $('#fState').value, sort: $('#sort').value,
  });
  state.subs = await api('/api/subscriptions?' + q.toString());
  const showMonthly = !!state.settings.show_monthly_price;
  const box = $('#subList');
  box.className = 'subs ' + state.view;
  box.innerHTML = state.subs.map((s) => {
    const priceMain = showMonthly ? s.monthly_cost : s.converted_price;
    const priceLabel = showMonthly ? 'per month (normalised)' : (s.currency.code !== state.mainCode ? `${s.price} ${s.currency.code}` : s.billing_label);
    return `<div class="sub ${s.inactive ? 'inactive' : ''}">
      <div class="avatar" style="background:${esc(s.color)}">${esc(s.emoji)}</div>
      <div class="grow"><div class="name">${esc(s.name)}</div>
        <div><span class="pill">${esc(s.next_payment)}</span><span class="pill">${esc(s.billing_label)}</span>${s.category ? `<span class="pill">${esc(s.category.icon)} ${esc(s.category.name)}</span>` : ''}${s.member ? `<span class="pill">👤 ${esc(s.member.name)}</span>` : ''}${s.auto_renew ? '' : '<span class="pill warn">manual renewal</span>'}${s.inactive ? '<span class="pill bad">inactive</span>' : ''}${s.cycle === 5 ? '<span class="pill">one-time</span>' : ''}</div>
      </div>
      <div class="price">${fmt(priceMain)}<small>${esc(priceLabel)}</small></div>
      <div class="row-actions"><button class="mini" data-renew="${s.id}" title="Mark paid / advance to next cycle">✔ Paid</button><button class="mini" data-edit="${s.id}">Edit</button></div>
    </div>`;
  }).join('');
  $('#emptySubs').classList.toggle('hidden', state.subs.length > 0);
  box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openModal(Number(b.dataset.edit))));
  box.querySelectorAll('[data-renew]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/subscriptions/${b.dataset.renew}/renew`, { method: 'POST' }); await refreshAll(); }));
}
['search', 'fCat', 'fMem', 'fState', 'sort'].forEach((id) => $('#' + id).addEventListener('input', loadSubs));
$('#viewList').addEventListener('click', () => { state.view = 'list'; $('#viewList').classList.add('on'); $('#viewGrid').classList.remove('on'); loadSubs(); });
$('#viewGrid').addEventListener('click', () => { state.view = 'grid'; $('#viewGrid').classList.add('on'); $('#viewList').classList.remove('on'); loadSubs(); });

// ---------- calendar ----------
async function loadCalendar() {
  const c = await api(`/api/calendar?year=${state.calY}&month=${state.calM}`);
  const d = new Date(state.calY, state.calM - 1, 1);
  $('#calTitle').textContent = d.toLocaleString('en', { month: 'long', year: 'numeric' });
  $('#calStats').textContent = `${c.totals.count} charge(s) · total ${fmt(c.totals.total)} · still due ${fmt(c.totals.due)} (in ${state.mainCode})`;
  const first = (new Date(state.calY, state.calM - 1, 1).getDay() + 6) % 7;
  const dim = new Date(state.calY, state.calM, 0).getDate();
  const today = new Date().toISOString().slice(0, 10);
  let h = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => `<div class="dow">${x}</div>`).join('');
  for (let i = 0; i < first; i++) h += '<div></div>';
  for (let day = 1; day <= dim; day++) {
    const isoD = `${state.calY}-${String(state.calM).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const evs = (c.days[day] || []).map((s) => `<div class="ev" data-edit="${s.id}" title="${esc(s.name)} — ${fmt(s.converted_price)}">${esc(s.emoji)} ${esc(s.name)}</div>`).join('');
    h += `<div class="cell ${isoD === today ? 'today' : ''}"><div class="d">${day}</div>${evs}</div>`;
  }
  $('#calGrid').innerHTML = h;
  $('#calGrid').querySelectorAll('[data-edit]').forEach((el) => el.addEventListener('click', () => openModal(Number(el.dataset.edit))));
}
$('#calPrev').addEventListener('click', () => { state.calM--; if (state.calM < 1) { state.calM = 12; state.calY--; } loadCalendar(); });
$('#calNext').addEventListener('click', () => { state.calM++; if (state.calM > 12) { state.calM = 1; state.calY++; } loadCalendar(); });
$('#calToday').addEventListener('click', () => { const n = new Date(); state.calY = n.getFullYear(); state.calM = n.getMonth() + 1; loadCalendar(); });

// ---------- stats ----------
function barRows(items, money = true) {
  const max = Math.max(1, ...items.map((i) => i.cost));
  return items.map((i) => `<div class="bar-row"><span>${i.icon ? esc(i.icon) + ' ' : ''}${esc(i.label)}</span><div class="track"><div class="fill" style="width:${Math.round((i.cost / max) * 100)}%;background:${esc(i.color || 'var(--brand)') || 'var(--brand)'}"></div></div><b>${money ? fmt(i.cost) : esc(i.cost)}</b></div>`).join('') || '<p class="muted">Not enough data.</p>';
}
async function loadStats() {
  const s = await api('/api/stats');
  $('#statKpis').innerHTML = [
    ['Monthly', fmt(s.totals.monthly)], ['Yearly', fmt(s.totals.yearly)], ['Per day', fmt(s.totals.per_day)],
    ['Average / sub', fmt(s.totals.average)], ['Active', s.totals.active],
    ['Most expensive', s.most_expensive ? `${fmt(s.most_expensive.monthly_cost)} · ${s.most_expensive.name}` : '—'],
  ].map(([k, v]) => `<div class="kpi"><b style="font-size:17px">${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  $('#byCat').innerHTML = barRows(s.by_category);
  $('#byMem').innerHTML = barRows(s.by_member);
  $('#byPay').innerHTML = barRows(s.by_payment);
  $('#byCycle').innerHTML = barRows(s.by_cycle);
  const max = Math.max(1, ...s.projection.map((p) => p.total));
  $('#proj').innerHTML = s.projection.map((p) => `<div class="b"><span>${esc(p.label)}</span><div class="col"><i style="height:${Math.max(4, Math.round((p.total / max) * 90))}px"></i></div><b>${fmt(p.total)}</b></div>`).join('');
}

// ---------- reminders ----------
async function loadReminders() {
  const r = await api('/api/reminders');
  $('#remindCount').textContent = r.count;
  $('#remindCount').classList.toggle('hidden', r.count === 0);
  $('#remindPanel').innerHTML = `<b>Due in next ${r.days} days (${r.count})</b>` + (r.reminders.map((s) => `<div class="pitem"><span>${esc(s.emoji)} ${esc(s.name)} · ${esc(s.next_payment)}</span><b>${fmt(s.converted_price)}</b></div>`).join('') || '<p class="muted">All clear.</p>');
}
$('#remindBtn').addEventListener('click', () => $('#remindPanel').classList.toggle('hidden'));

// ---------- modal ----------
function openModal(id) {
  const s = id ? state.subs.find((x) => x.id === id) : null;
  $('#mTitle').textContent = s ? 'Edit subscription' : 'New subscription';
  $('#mMsg').textContent = '';
  $('#fId').value = s?.id || '';
  $('#fName').value = s?.name || ''; $('#fPrice').value = s?.price ?? '';
  $('#fCurrency').value = s?.currency_id || state.settings.main_currency_id || state.curs[0]?.id;
  $('#fFreq').value = s?.frequency || 1; $('#fCycle').value = s?.cycle || 3;
  $('#fNext').value = s?.next_payment || new Date().toISOString().slice(0, 10);
  $('#fStart').value = s?.start_date || $('#fNext').value;
  $('#fCategory').value = s?.category_id || state.cats[0]?.id || '';
  $('#fMember').value = s?.member_id || state.mems[0]?.id || '';
  $('#fPay').value = s?.payment_method_id || state.pays[0]?.id || '';
  $('#fEmoji').value = s?.emoji || '🔁'; $('#fColor').value = s?.color || '#3e63dd';
  $('#fUrl').value = s?.url || ''; $('#fNotes').value = s?.notes || '';
  $('#fAuto').checked = s ? !!s.auto_renew : true; $('#fInactive').checked = !!s?.inactive;
  $('#mDelete').classList.toggle('hidden', !s);
  $('#modal').classList.remove('hidden');
}
$('#addBtn').addEventListener('click', () => openModal());
$('#emptyAdd').addEventListener('click', () => openModal());
$('#mClose').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
$('#mDelete').addEventListener('click', async () => {
  if (!confirm('Delete this subscription?')) return;
  await api('/api/subscriptions/' + $('#fId').value, { method: 'DELETE' });
  $('#modal').classList.add('hidden'); await refreshAll();
});
$('#mForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('#fName').value.trim(), price: Number($('#fPrice').value), currency_id: Number($('#fCurrency').value),
    frequency: Number($('#fFreq').value), cycle: Number($('#fCycle').value), next_payment: $('#fNext').value,
    start_date: $('#fStart').value || $('#fNext').value, category_id: Number($('#fCategory').value) || null,
    member_id: Number($('#fMember').value) || null, payment_method_id: Number($('#fPay').value) || null,
    emoji: $('#fEmoji').value || '🔁', color: $('#fColor').value, url: $('#fUrl').value.trim(), notes: $('#fNotes').value,
    auto_renew: $('#fAuto').checked ? 1 : 0, inactive: $('#fInactive').checked ? 1 : 0,
  };
  try {
    if ($('#fId').value) await api('/api/subscriptions/' + $('#fId').value, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/subscriptions', { method: 'POST', body: JSON.stringify(body) });
    $('#modal').classList.add('hidden'); await refreshAll();
  } catch (err) { $('#mMsg').textContent = err.message; }
});

// ---------- manage ----------
function rows(el, items, label, del) {
  $(el).innerHTML = items.map((x) => `<div class="rrow"><span>${x.color ? `<i class="dot" style="background:${esc(x.color)}"></i>` : ''}${x.icon ? esc(x.icon) + ' ' : ''}<b>${esc(x.name || x.code)}</b> ${x.code ? `<span class="muted">${esc(x.code)} · rate ${Number(x.rate_to_main).toFixed(4)}</span>` : ''}</span><span><button class="mini" data-e="${x.id}">Edit</button> <button class="mini" data-d="${x.id}">Delete</button></span></div>`).join('') || '<p class="muted">None yet.</p>';
  $(el).querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', async () => { try { await api(label + '/' + b.dataset.d, { method: 'DELETE' }); await refreshAll(); } catch (e) { alert(e.message); } }));
  $(el).querySelectorAll('[data-e]').forEach((b) => b.addEventListener('click', () => del(Number(b.dataset.e))));
}
function fillManage() {
  rows('#catList', state.cats, '/api/categories', async (id) => {
    const c = state.cats.find((x) => x.id === id);
    const name = prompt('Category name', c.name); if (name === null) return;
    await api('/api/categories/' + id, { method: 'PUT', body: JSON.stringify({ name }) }); await refreshAll();
  });
  rows('#memList', state.mems, '/api/members', async (id) => {
    const c = state.mems.find((x) => x.id === id);
    const name = prompt('Member name', c.name); if (name === null) return;
    await api('/api/members/' + id, { method: 'PUT', body: JSON.stringify({ name }) }); await refreshAll();
  });
  rows('#payList', state.pays, '/api/payment-methods', async (id) => {
    const c = state.pays.find((x) => x.id === id);
    const name = prompt('Payment method name', c.name); if (name === null) return;
    await api('/api/payment-methods/' + id, { method: 'PUT', body: JSON.stringify({ name }) }); await refreshAll();
  });
  rows('#curList', state.curs, '/api/currencies', async (id) => {
    const c = state.curs.find((x) => x.id === id);
    const rate = prompt(`Rate to main (${state.mainCode}) for 1 ${c.code} (current ${c.rate_to_main})`, c.rate_to_main); if (rate === null) return;
    await api('/api/currencies/' + id, { method: 'PUT', body: JSON.stringify({ rate_to_main: Number(rate) }) }); await refreshAll();
  });
  $('#setMain').innerHTML = state.curs.map((x) => `<option value="${x.id}" ${x.id === state.settings.main_currency_id ? 'selected' : ''}>${esc(x.code)}</option>`).join('');
  $('#setBudget').value = state.settings.monthly_budget || 0;
  $('#setRemind').value = state.settings.reminder_days || 7;
  $('#setMonthly').checked = !!state.settings.show_monthly_price;
}
$('#addCat').addEventListener('click', async () => { const n = prompt('Category name'); if (!n) return; await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: n }) }); await refreshAll(); });
$('#addMem').addEventListener('click', async () => { const n = prompt('Member name'); if (!n) return; await api('/api/members', { method: 'POST', body: JSON.stringify({ name: n }) }); await refreshAll(); });
$('#addPay').addEventListener('click', async () => { const n = prompt('Payment method name'); if (!n) return; await api('/api/payment-methods', { method: 'POST', body: JSON.stringify({ name: n }) }); await refreshAll(); });
$('#saveSettings').addEventListener('click', async () => {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ main_currency_id: Number($('#setMain').value), monthly_budget: Number($('#setBudget').value), reminder_days: Number($('#setRemind').value), show_monthly_price: $('#setMonthly').checked ? 1 : 0 }) });
  $('#setMsg').textContent = 'Saved ✓'; await refreshAll(); setTimeout(() => $('#setMsg').textContent = '', 2000);
});
$('#refreshRates').addEventListener('click', async () => {
  try { const r = await api('/api/currencies/refresh', { method: 'POST', body: '{}' }); alert(`Updated ${r.updated} rates (base ${r.base})`); await refreshAll(); }
  catch (e) { alert(e.message); }
});
$('#resetDemo').addEventListener('click', async () => { if (!confirm('Reset to demo data?')) return; await api('/api/reset', { method: 'POST' }); await refreshAll(); });

refreshAll().catch((e) => document.body.insertAdjacentHTML('beforeend', `<p style="color:red;padding:20px">Failed to load API: ${esc(e.message)}</p>`));
