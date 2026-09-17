// Recurra — self-hosted recurring subscription tracker.
// Reimplemented from scratch (Node.js built-ins + SQLite) inspired by Wallos interaction patterns.
// Wallos upstream: https://github.com/ellite/Wallos (GPL-3.0) at 52820e8. This derivative is GPL-3.0-only.
// Zero runtime dependencies: uses node:http + node:sqlite + vanilla frontend.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.RECURRA_DB || path.join(DATA_DIR, 'recurra.db');
const PORT = Number(process.env.PORT || 8282);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- DB setup
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#3e63dd',
  icon TEXT NOT NULL DEFAULT '📦'
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#30a46c'
);
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT '💳'
);
CREATE TABLE IF NOT EXISTS currencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  rate_to_main REAL NOT NULL DEFAULT 1,
  is_main INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  main_currency_id INTEGER REFERENCES currencies(id),
  monthly_budget REAL NOT NULL DEFAULT 0,
  convert_currency INTEGER NOT NULL DEFAULT 1,
  show_monthly_price INTEGER NOT NULL DEFAULT 0,
  reminder_days INTEGER NOT NULL DEFAULT 7
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  currency_id INTEGER NOT NULL REFERENCES currencies(id),
  cycle INTEGER NOT NULL DEFAULT 3,
  frequency INTEGER NOT NULL DEFAULT 1,
  next_payment TEXT NOT NULL,
  start_date TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  payment_method_id INTEGER REFERENCES payment_methods(id) ON DELETE SET NULL,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  inactive INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  notify_days INTEGER NOT NULL DEFAULT -1,
  color TEXT NOT NULL DEFAULT '#3e63dd',
  emoji TEXT NOT NULL DEFAULT '🔁',
  created_at TEXT NOT NULL DEFAULT (date('now'))
);
`);

// ---------------------------------------------------------------- helpers
const CYCLES = { 1: 'days', 2: 'weeks', 3: 'months', 4: 'years', 5: 'one-time' };
const CYCLE_LABEL = { 1: 'day', 2: 'week', 3: 'month', 4: 'year', 5: 'once' };

function iso(d) { return d.toISOString().slice(0, 10); }
function todayISO() { const d = new Date(); return iso(d); }
function addDays(base, n) { const d = new Date(base + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); }
function parseDay(s) { return new Date(s + 'T12:00:00'); }

export function pricePerMonth(cycle, frequency, price) {
  const f = Math.max(1, Number(frequency) || 1);
  const p = Number(price) || 0;
  switch (Number(cycle)) {
    case 1: return p * (30 / f);
    case 2: return p * (4.35 / f);
    case 3: return p * (1 / f);
    case 4: return p / (12 * f);
    case 5: return 0;
    default: return p;
  }
}

function getMainCurrency() {
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  if (s?.main_currency_id) {
    const c = db.prepare('SELECT * FROM currencies WHERE id = ?').get(s.main_currency_id);
    if (c) return c;
  }
  return db.prepare('SELECT * FROM currencies WHERE is_main = 1').get()
      || db.prepare('SELECT * FROM currencies ORDER BY id LIMIT 1').get();
}

function convertToMain(price, currencyId) {
  const cur = db.prepare('SELECT * FROM currencies WHERE id = ?').get(currencyId);
  if (!cur) return Number(price) || 0;
  return (Number(price) || 0) * (Number(cur.rate_to_main) || 1);
}

function billingLabel(cycle, frequency) {
  const f = Number(frequency) || 1;
  if (Number(cycle) === 5) return 'One-time';
  const base = CYCLE_LABEL[cycle] || 'month';
  return f === 1 ? `Every ${base}` : `Every ${f} ${base}s`;
}

function advanceDate(dateStr, cycle, frequency) {
  const d = parseDay(dateStr);
  const f = Math.max(1, Number(frequency) || 1);
  switch (Number(cycle)) {
    case 1: d.setDate(d.getDate() + f); break;
    case 2: d.setDate(d.getDate() + 7 * f); break;
    case 3: d.setMonth(d.getMonth() + f); break;
    case 4: d.setFullYear(d.getFullYear() + f); break;
    case 5: break;
  }
  return iso(d);
}

// Project occurrences of one subscription inside [rangeStart, rangeEnd] (inclusive ISO strings)
function occurrencesInRange(sub, rangeStart, rangeEnd) {
  const out = [];
  if (sub.inactive) return out;
  const rs = parseDay(rangeStart), re = parseDay(rangeEnd);
  const startLimit = sub.start_date ? parseDay(sub.start_date) : parseDay(sub.next_payment);
  if (Number(sub.cycle) === 5) {
    const d = parseDay(sub.next_payment);
    if (d >= rs && d <= re && d >= startLimit) out.push(sub.next_payment);
    return out;
  }
  // walk forward from next_payment; also walk backward to catch earlier cycle hits in range
  let cursor = parseDay(sub.next_payment);
  // rewind while previous occurrence still >= rangeStart - 2 cycles (bounded, max 400 steps)
  for (let i = 0; i < 400; i++) {
    const prev = parseDay(iso(cursor));
    const back = (() => { const d = new Date(prev); const f = Math.max(1, Number(sub.frequency) || 1);
      switch (Number(sub.cycle)) { case 1: d.setDate(d.getDate() - f); break; case 2: d.setDate(d.getDate() - 7*f); break;
        case 3: d.setMonth(d.getMonth() - f); break; case 4: d.setFullYear(d.getFullYear() - f); break; default: return null; } return d; })();
    if (!back || back < rs) break;
    // only rewind if back is still on/after subscription start and could fall in range
    if (back >= startLimit) cursor = back; else break;
    if (iso(cursor) <= rangeStart) break;
  }
  for (let i = 0; i < 500; i++) {
    const cur = iso(cursor);
    if (cur > rangeEnd) break;
    if (cur >= rangeStart && cursor >= startLimit) out.push(cur);
    const nxt = advanceDate(cur, sub.cycle, sub.frequency);
    if (nxt <= cur) break;
    cursor = parseDay(nxt);
  }
  return out;
}

function enrich(sub) {
  const cat = sub.category_id ? db.prepare('SELECT * FROM categories WHERE id = ?').get(sub.category_id) : null;
  const mem = sub.member_id ? db.prepare('SELECT * FROM members WHERE id = ?').get(sub.member_id) : null;
  const pay = sub.payment_method_id ? db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(sub.payment_method_id) : null;
  const cur = db.prepare('SELECT * FROM currencies WHERE id = ?').get(sub.currency_id);
  const main = getMainCurrency();
  const converted = convertToMain(sub.price, sub.currency_id);
  return {
    ...sub,
    price: Number(sub.price),
    category: cat ? { id: cat.id, name: cat.name, color: cat.color, icon: cat.icon } : null,
    member: mem ? { id: mem.id, name: mem.name, color: mem.color } : null,
    payment_method: pay ? { id: pay.id, name: pay.name, icon: pay.icon } : null,
    currency: cur ? { id: cur.id, code: cur.code, symbol: cur.symbol, name: cur.name } : null,
    billing_label: billingLabel(sub.cycle, sub.frequency),
    monthly_cost: sub.inactive ? 0 : pricePerMonth(sub.cycle, sub.frequency, converted),
    converted_price: converted,
    main_currency: main ? main.code : 'USD',
  };
}

// ---------------------------------------------------------------- seed
function count(table) { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }

function seedIfEmpty(force = false) {
  if (!force && count('currencies') > 0 && count('subscriptions') > 0) return;
  db.exec('DELETE FROM subscriptions; DELETE FROM categories; DELETE FROM members; DELETE FROM payment_methods; DELETE FROM currencies; DELETE FROM settings;');
  const insCur = db.prepare('INSERT INTO currencies (code, name, symbol, rate_to_main, is_main) VALUES (?, ?, ?, ?, ?)');
  const usd = insCur.run('USD', 'US Dollar', '$', 1, 1).lastInsertRowid;
  const eur = insCur.run('EUR', 'Euro', '€', 1.08, 0).lastInsertRowid;
  const gbp = insCur.run('GBP', 'British Pound', '£', 1.27, 0).lastInsertRowid;
  const inr = insCur.run('INR', 'Indian Rupee', '₹', 0.012, 0).lastInsertRowid;
  const jpy = insCur.run('JPY', 'Japanese Yen', '¥', 0.0067, 0).lastInsertRowid;
  const insCat = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)');
  const catEnt = insCat.run('Entertainment', '#e5484d', '🎬').lastInsertRowid;
  const catMus = insCat.run('Music', '#8e4ec6', '🎵').lastInsertRowid;
  const catCloud = insCat.run('Cloud & Storage', '#3e63dd', '☁️').lastInsertRowid;
  const catProd = insCat.run('Productivity', '#0091ff', '🛠️').lastInsertRowid;
  const catNews = insCat.run('News & Reading', '#f5a524', '📰').lastInsertRowid;
  const catFit = insCat.run('Fitness', '#30a46c', '🏋️').lastInsertRowid;
  const catGame = insCat.run('Gaming', '#d6409f', '🎮').lastInsertRowid;
  const catUtil = insCat.run('Utilities', '#12a594', '🔌').lastInsertRowid;
  const insMem = db.prepare('INSERT INTO members (name, color) VALUES (?, ?)');
  const mAlex = insMem.run('Alex', '#3e63dd').lastInsertRowid;
  const mSam = insMem.run('Sam', '#8e4ec6').lastInsertRowid;
  const mFam = insMem.run('Family', '#30a46c').lastInsertRowid;
  const insPay = db.prepare('INSERT INTO payment_methods (name, icon) VALUES (?, ?)');
  const pCard = insPay.run('Credit Card', '💳').lastInsertRowid;
  const pPaypal = insPay.run('PayPal', '🅿️').lastInsertRowid;
  const pBank = insPay.run('Bank Transfer', '🏦').lastInsertRowid;
  const pUpi = insPay.run('UPI', '⚡').lastInsertRowid;
  db.prepare('INSERT INTO settings (id, main_currency_id, monthly_budget, convert_currency, show_monthly_price, reminder_days) VALUES (1, ?, ?, 1, 0, 7)')
    .run(usd, 80);

  const t = todayISO();
  const seedSubs = [
    ['StreamFlix', 15.99, usd, 3, 1, addDays(t, 3), addDays(t, -300), catEnt, mAlex, pCard, 1, 0, 'https://example.com/streamflix', '4K household plan', '#e5484d', '🎬'],
    ['TuneWave', 9.99, usd, 3, 1, addDays(t, 6), addDays(t, -200), catMus, mAlex, pPaypal, 1, 0, '', 'Individual plan', '#8e4ec6', '🎵'],
    ['Nimbus Drive', 2.99, eur, 3, 1, addDays(t, 2), addDays(t, -150), catCloud, mSam, pCard, 1, 0, '', '200 GB storage', '#3e63dd', '☁️'],
    ['TaskFlow Pro', 12.0, usd, 3, 1, addDays(t, 11), addDays(t, -90), catProd, mAlex, pCard, 1, 0, '', 'Team workspace', '#0091ff', '🛠️'],
    ['Daily Herald', 8.0, gbp, 3, 1, addDays(t, 9), addDays(t, -400), catNews, mFam, pBank, 1, 0, '', 'Weekend print + digital', '#f5a524', '📰'],
    ['FitPulse', 29.99, usd, 4, 1, addDays(t, 20), addDays(t, -345), catFit, mSam, pCard, 1, 0, '', 'Annual gym + app', '#30a46c', '🏋️'],
    ['PixelPlay', 14.99, usd, 3, 1, addDays(t, 1), addDays(t, -60), catGame, mSam, pPaypal, 0, 0, '', 'Manual renewal — decide each month', '#d6409f', '🎮'],
    ['Volt Domain', 18.99, usd, 4, 1, addDays(t, 45), addDays(t, -320), catUtil, mAlex, pBank, 1, 0, '', 'Domain + DNS renewal', '#12a594', '🔌'],
    ['CinePass India', 299.0, inr, 3, 1, addDays(t, 5), addDays(t, -120), catEnt, mFam, pUpi, 1, 0, '', 'Regional streaming', '#e5484d', '🍿'],
    ['Manga Archive', 980.0, jpy, 3, 1, addDays(t, 14), addDays(t, -80), catNews, mSam, pCard, 1, 0, '', 'Digital manga subscription', '#f5a524', '📚'],
    ['Old Music Box', 4.99, usd, 3, 1, addDays(t, -40), addDays(t, -400), catMus, mAlex, pCard, 1, 1, '', 'Cancelled — kept for savings view', '#8e4ec6', '📻'],
    ['Server Backup Once', 149.0, usd, 5, 1, addDays(t, 30), t, catCloud, mAlex, pBank, 1, 0, '', 'One-time setup fee', '#3e63dd', '🖥️'],
  ];
  const ins = db.prepare(`INSERT INTO subscriptions
    (name, price, currency_id, cycle, frequency, next_payment, start_date, category_id, member_id, payment_method_id, auto_renew, inactive, url, notes, color, emoji)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of seedSubs) ins.run(...s);
  console.log('[recurra] seeded demo data');
}

const forceSeed = process.argv.includes('--seed');
if (forceSeed) { seedIfEmpty(true); process.exit(0); }
seedIfEmpty(false);

// ---------------------------------------------------------------- API logic
function getSettings() {
  let s = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  if (!s) { db.prepare('INSERT INTO settings (id, monthly_budget) VALUES (1, 0)').run(); s = db.prepare('SELECT * FROM settings WHERE id = 1').get(); }
  const main = getMainCurrency();
  return { ...s, main_currency: main ? { id: main.id, code: main.code, symbol: main.symbol } : null };
}

function listSubscriptions(q) {
  let rows = db.prepare('SELECT * FROM subscriptions ORDER BY next_payment ASC').all();
  if (q.state === 'active') rows = rows.filter(r => !r.inactive);
  if (q.state === 'inactive') rows = rows.filter(r => r.inactive);
  if (q.category) { const ids = new Set(String(q.category).split(',').map(Number)); rows = rows.filter(r => ids.has(r.category_id)); }
  if (q.member) { const ids = new Set(String(q.member).split(',').map(Number)); rows = rows.filter(r => ids.has(r.member_id)); }
  if (q.payment) { const ids = new Set(String(q.payment).split(',').map(Number)); rows = rows.filter(r => ids.has(r.payment_method_id)); }
  if (q.search) { const s = String(q.search).toLowerCase(); rows = rows.filter(r => (r.name + ' ' + (r.notes || '')).toLowerCase().includes(s)); }
  const sort = q.sort || 'next_payment';
  const order = (q.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  const val = (r) => sort === 'price' ? convertToMain(r.price, r.currency_id)
    : sort === 'name' ? String(r.name).toLowerCase()
    : sort === 'category_id' ? (r.category_id || 0)
    : sort === 'member_id' ? (r.member_id || 0)
    : r.next_payment;
  rows.sort((a, b) => {
    // inactive always sink unless explicitly sorting by inactive
    if (sort !== 'inactive' && Boolean(a.inactive) !== Boolean(b.inactive)) return a.inactive - b.inactive;
    const av = val(a), bv = val(b);
    if (av < bv) return -1 * order; if (av > bv) return 1 * order; return 0;
  });
  return rows.map(enrich);
}

function computeOverview() {
  const settings = getSettings();
  const main = getMainCurrency();
  const all = db.prepare('SELECT * FROM subscriptions').all();
  const active = all.filter(s => !s.inactive && s.cycle !== 5);
  const activeInclOnce = all.filter(s => !s.inactive);
  const t = todayISO();
  const upcoming = all.filter(s => !s.inactive).sort((a, b) => a.next_payment < b.next_payment ? -1 : 1).slice(0, 5).map(enrich);
  const overdue = all.filter(s => !s.inactive && s.auto_renew === 0 && s.cycle !== 5 && s.next_payment < t).map(enrich);
  let monthly = 0, savings = 0;
  for (const s of all) {
    const m = pricePerMonth(s.cycle, s.frequency, convertToMain(s.price, s.currency_id));
    if (s.inactive) savings += m; else monthly += m;
  }
  const yearly = monthly * 12;
  const budget = Number(settings.monthly_budget) || 0;
  const budgetUsed = budget > 0 ? Math.min(100, (monthly / budget) * 100) : 0;
  // amount due remainder of this month via occurrences
  const now = new Date();
  const monthStart = iso(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  let dueThisMonth = 0, countThisMonth = 0;
  for (const s of activeInclOnce) {
    for (const occ of occurrencesInRange(s, t, monthEnd)) {
      dueThisMonth += convertToMain(s.price, s.currency_id);
      countThisMonth++;
    }
  }
  void monthStart;
  const reminderDays = Number(settings.reminder_days) || 7;
  const horizon = addDays(t, reminderDays);
  const dueSoon = all.filter(s => !s.inactive && s.next_payment >= t && s.next_payment <= horizon).length;
  return {
    main_currency: main,
    counts: { active: active.length, inactive: all.filter(s => s.inactive).length, total: all.length, due_this_month: countThisMonth, due_soon: dueSoon },
    costs: { monthly: round2(monthly), yearly: round2(yearly), savings_monthly: round2(savings), savings_yearly: round2(savings * 12), due_this_month: round2(dueThisMonth) },
    budget: { monthly: budget, used_pct: round2(budgetUsed), left: round2(Math.max(0, budget - monthly)), over: round2(Math.max(0, monthly - budget)) },
    upcoming, overdue,
  };
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function computeStats() {
  const main = getMainCurrency();
  const all = db.prepare('SELECT * FROM subscriptions').all();
  const active = all.filter(s => !s.inactive);
  let monthly = 0; for (const s of active) monthly += pricePerMonth(s.cycle, s.frequency, convertToMain(s.price, s.currency_id));
  const perDay = monthly / 30;
  const avg = active.filter(s => s.cycle !== 5).length ? monthly / active.filter(s => s.cycle !== 5).length : 0;
  const ranked = [...active].sort((a, b) => pricePerMonth(b.cycle, b.frequency, convertToMain(b.price, b.currency_id)) - pricePerMonth(a.cycle, a.frequency, convertToMain(a.price, a.currency_id)));
  const group = (key, labelTable) => {
    const m = new Map();
    for (const s of active) {
      const id = s[key] ?? 0;
      const cost = pricePerMonth(s.cycle, s.frequency, convertToMain(s.price, s.currency_id));
      m.set(id, (m.get(id) || 0) + cost);
    }
    return [...m.entries()].map(([id, cost]) => {
      let label = '—', color = '#888', icon = '';
      if (labelTable === 'categories' && id) { const c = db.prepare('SELECT * FROM categories WHERE id=?').get(id); if (c) { label = c.name; color = c.color; icon = c.icon; } }
      if (labelTable === 'members' && id) { const c = db.prepare('SELECT * FROM members WHERE id=?').get(id); if (c) { label = c.name; color = c.color; } }
      if (labelTable === 'payments' && id) { const c = db.prepare('SELECT * FROM payment_methods WHERE id=?').get(id); if (c) { label = c.name; icon = c.icon; } }
      if (labelTable === 'cycles' && id) { label = id === 5 ? 'One-time' : billingLabel(Number(id), 1); }
      if (labelTable === 'currencies' && id) { const c = db.prepare('SELECT * FROM currencies WHERE id=?').get(id); if (c) { label = c.code; } }
      return { id, label, color, icon, cost: round2(cost), pct: monthly ? round2((cost / monthly) * 100) : 0 };
    }).sort((a, b) => b.cost - a.cost);
  };
  // 12-month projection from today
  const t = todayISO();
  const proj = [];
  const base = new Date(t + 'T12:00:00');
  for (let i = 0; i < 12; i++) {
    const y = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const s = iso(y), e = iso(new Date(y.getFullYear(), y.getMonth() + 1, 0));
    let total = 0;
    for (const sub of active) for (const occ of occurrencesInRange(sub, s, e)) total += convertToMain(sub.price, sub.currency_id);
    proj.push({ label: y.toLocaleString('en', { month: 'short' }) + (i === 0 ? ' *' : ''), total: round2(total) });
  }
  return {
    main_currency: main,
    totals: { monthly: round2(monthly), yearly: round2(monthly * 12), per_day: round2(perDay), average: round2(avg), active: active.length },
    most_expensive: ranked[0] ? enrich(ranked[0]) : null,
    cheapest: ranked.length ? enrich(ranked[ranked.length - 1]) : null,
    by_category: group('category_id', 'categories'),
    by_member: group('member_id', 'members'),
    by_payment: group('payment_method_id', 'payments'),
    by_cycle: group('cycle', 'cycles'),
    by_currency: group('currency_id', 'currencies'),
    projection: proj,
  };
}

function computeCalendar(year, month) {
  const y = Number(year), m = Number(month);
  const start = iso(new Date(y, m - 1, 1));
  const end = iso(new Date(y, m, 0));
  const all = db.prepare('SELECT * FROM subscriptions WHERE inactive = 0').all();
  const days = {};
  let total = 0, count = 0;
  const t = todayISO();
  let due = 0;
  for (const s of all) {
    for (const occ of occurrencesInRange(s, start, end)) {
      const day = Number(occ.slice(8, 10));
      (days[day] ||= []).push(enrich(s));
      const c = convertToMain(s.price, s.currency_id);
      total += c; count++;
      if (occ >= t) due += c;
    }
  }
  return { year: y, month: m, start, end, days, totals: { count, total: round2(total), due: round2(due) } };
}

// ---------------------------------------------------------------- HTTP
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function parseBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => { if (!buf) return resolve({}); try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  return null;
}

function validateSub(b, isUpdate = false) {
  const errs = [];
  if (!isUpdate || b.name !== undefined) { if (!String(b.name || '').trim()) errs.push('name is required'); }
  if (b.price !== undefined && !(Number(b.price) >= 0)) errs.push('price must be >= 0');
  if (b.cycle !== undefined && ![1, 2, 3, 4, 5].includes(Number(b.cycle))) errs.push('cycle must be 1-5');
  if (b.frequency !== undefined && !(Number(b.frequency) >= 1 && Number(b.frequency) <= 366)) errs.push('frequency must be 1-366');
  if (b.next_payment !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.next_payment || ''))) errs.push('next_payment must be YYYY-MM-DD');
  return errs;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams.entries());

    if (!p.startsWith('/api/')) {
      if (serveStatic(req, res) === null) {
        res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
      }
      return;
    }

    // ---- read-only meta
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, app: 'recurra', version: '0.1.0', db: path.basename(DB_PATH) });
    if (req.method === 'GET' && p === '/api/overview') return send(res, 200, computeOverview());
    if (req.method === 'GET' && p === '/api/stats') return send(res, 200, computeStats());
    if (req.method === 'GET' && p === '/api/calendar') {
      const now = new Date();
      const year = q.year || now.getFullYear(), month = q.month || (now.getMonth() + 1);
      return send(res, 200, computeCalendar(year, month));
    }
    if (req.method === 'GET' && p === '/api/reminders') {
      const s = getSettings(); const days = Number(q.days ?? s.reminder_days ?? 7);
      const t = todayISO(), horizon = addDays(t, days);
      const rows = db.prepare('SELECT * FROM subscriptions WHERE inactive = 0 AND next_payment >= ? AND next_payment <= ? ORDER BY next_payment').all(t, horizon);
      return send(res, 200, { days, horizon, count: rows.length, reminders: rows.map(enrich) });
    }
    if (req.method === 'GET' && p === '/api/cycles') {
      return send(res, 200, [{ id: 1, name: 'Days' }, { id: 2, name: 'Weeks' }, { id: 3, name: 'Months' }, { id: 4, name: 'Years' }, { id: 5, name: 'One-time' }]);
    }
    if (req.method === 'GET' && p === '/api/settings') return send(res, 200, getSettings());

    // ---- subscriptions
    if (p === '/api/subscriptions' && req.method === 'GET') return send(res, 200, listSubscriptions(q));
    if (p === '/api/subscriptions' && req.method === 'POST') {
      const b = await parseBody(req);
      const errs = validateSub(b);
      if (errs.length) return send(res, 400, { error: errs.join('; ') });
      const r = db.prepare(`INSERT INTO subscriptions (name, price, currency_id, cycle, frequency, next_payment, start_date, category_id, member_id, payment_method_id, auto_renew, inactive, url, notes, notify_days, color, emoji)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(b.name).trim(), Number(b.price ?? 0), Number(b.currency_id) || getMainCurrency().id,
        Number(b.cycle ?? 3), Number(b.frequency ?? 1), b.next_payment, b.start_date || b.next_payment,
        b.category_id ?? null, b.member_id ?? null, b.payment_method_id ?? null,
        b.auto_renew === false || b.auto_renew === 0 ? 0 : 1, b.inactive ? 1 : 0,
        String(b.url || ''), String(b.notes || ''), Number(b.notify_days ?? -1),
        String(b.color || '#3e63dd'), String(b.emoji || '🔁'));
      return send(res, 201, enrich(db.prepare('SELECT * FROM subscriptions WHERE id=?').get(r.lastInsertRowid)));
    }
    let m = p.match(/^\/api\/subscriptions\/(\d+)(\/renew)?$/);
    if (m) {
      const id = Number(m[1]);
      const row = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
      if (!row) return send(res, 404, { error: 'not found' });
      if (req.method === 'GET' && !m[2]) return send(res, 200, enrich(row));
      if (req.method === 'POST' && m[2]) {
        const nxt = advanceDate(row.next_payment, row.cycle, row.frequency);
        db.prepare('UPDATE subscriptions SET next_payment=? WHERE id=?').run(nxt, id);
        return send(res, 200, enrich(db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id)));
      }
      if ((req.method === 'PUT' || req.method === 'PATCH') && !m[2]) {
        const b = await parseBody(req);
        const errs = validateSub(b, true);
        if (errs.length) return send(res, 400, { error: errs.join('; ') });
        const merged = { ...row, ...b };
        db.prepare(`UPDATE subscriptions SET name=?, price=?, currency_id=?, cycle=?, frequency=?, next_payment=?, start_date=?, category_id=?, member_id=?, payment_method_id=?, auto_renew=?, inactive=?, url=?, notes=?, notify_days=?, color=?, emoji=? WHERE id=?`)
          .run(String(merged.name).trim(), Number(merged.price), Number(merged.currency_id), Number(merged.cycle), Number(merged.frequency),
            merged.next_payment, merged.start_date || merged.next_payment, merged.category_id ?? null, merged.member_id ?? null,
            merged.payment_method_id ?? null, merged.auto_renew ? 1 : 0, merged.inactive ? 1 : 0,
            String(merged.url || ''), String(merged.notes || ''), Number(merged.notify_days ?? -1),
            String(merged.color || '#3e63dd'), String(merged.emoji || '🔁'), id);
        return send(res, 200, enrich(db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id)));
      }
      if (req.method === 'DELETE' && !m[2]) { db.prepare('DELETE FROM subscriptions WHERE id=?').run(id); return send(res, 200, { ok: true }); }
    }

    // ---- generic lookup CRUD
    const lookups = { '/api/categories': 'categories', '/api/members': 'members', '/api/payment-methods': 'payment_methods', '/api/currencies': 'currencies' };
    for (const [route, table] of Object.entries(lookups)) {
      if (p === route && req.method === 'GET') {
        const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'currencies' ? 'code' : 'name'}`).all();
        if (table === 'currencies') { const main = getMainCurrency(); return send(res, 200, rows.map(r => ({ ...r, is_main: main && main.id === r.id ? 1 : r.is_main }))); }
        return send(res, 200, rows);
      }
      if (p === route && req.method === 'POST') {
        const b = await parseBody(req);
        try {
          let r;
          if (table === 'categories') r = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)').run(String(b.name).trim(), String(b.color || '#3e63dd'), String(b.icon || '📦'));
          if (table === 'members') r = db.prepare('INSERT INTO members (name, color) VALUES (?, ?)').run(String(b.name).trim(), String(b.color || '#30a46c'));
          if (table === 'payment_methods') r = db.prepare('INSERT INTO payment_methods (name, icon) VALUES (?, ?)').run(String(b.name).trim(), String(b.icon || '💳'));
          if (table === 'currencies') {
            if (!b.code) return send(res, 400, { error: 'code required' });
            r = db.prepare('INSERT INTO currencies (code, name, symbol, rate_to_main) VALUES (?, ?, ?, ?)').run(String(b.code).toUpperCase().trim(), String(b.name || b.code), String(b.symbol || ''), Number(b.rate_to_main ?? 1));
          }
          return send(res, 201, db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(r.lastInsertRowid));
        } catch (e) { return send(res, 400, { error: 'name/code must be unique' }); }
      }
      const lm = p.match(new RegExp('^' + route + '/(\\d+)$'));
      if (lm) {
        const id = Number(lm[1]);
        if (req.method === 'PUT' || req.method === 'PATCH') {
          const b = await parseBody(req);
          try {
            if (table === 'categories') db.prepare('UPDATE categories SET name=COALESCE(?,name), color=COALESCE(?,color), icon=COALESCE(?,icon) WHERE id=?').run(b.name ?? null, b.color ?? null, b.icon ?? null, id);
            if (table === 'members') db.prepare('UPDATE members SET name=COALESCE(?,name), color=COALESCE(?,color) WHERE id=?').run(b.name ?? null, b.color ?? null, id);
            if (table === 'payment_methods') db.prepare('UPDATE payment_methods SET name=COALESCE(?,name), icon=COALESCE(?,icon) WHERE id=?').run(b.name ?? null, b.icon ?? null, id);
            if (table === 'currencies') db.prepare('UPDATE currencies SET code=COALESCE(?,code), name=COALESCE(?,name), symbol=COALESCE(?,symbol), rate_to_main=COALESCE(?,rate_to_main) WHERE id=?').run(b.code ?? null, b.name ?? null, b.symbol ?? null, b.rate_to_main ?? null, id);
          } catch { return send(res, 400, { error: 'unique constraint' }); }
          return send(res, 200, db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) || {});
        }
        if (req.method === 'DELETE') {
          const used = table === 'categories' ? db.prepare('SELECT COUNT(*) n FROM subscriptions WHERE category_id=?').get(id).n
            : table === 'members' ? db.prepare('SELECT COUNT(*) n FROM subscriptions WHERE member_id=?').get(id).n
            : table === 'payment_methods' ? db.prepare('SELECT COUNT(*) n FROM subscriptions WHERE payment_method_id=?').get(id).n
            : db.prepare('SELECT COUNT(*) n FROM subscriptions WHERE currency_id=?').get(id).n;
          if (used > 0) return send(res, 400, { error: `in use by ${used} subscription(s)` });
          db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
          return send(res, 200, { ok: true });
        }
      }
    }

    if (p === '/api/settings' && (req.method === 'PUT' || req.method === 'PATCH')) {
      const b = await parseBody(req);
      const cur = getSettings();
      const merged = { ...cur, ...b };
      if (merged.main_currency_id) {
        db.prepare('UPDATE currencies SET is_main = 0').run();
        db.prepare('UPDATE currencies SET is_main = 1 WHERE id = ?').run(Number(merged.main_currency_id));
      }
      db.prepare('UPDATE settings SET main_currency_id=?, monthly_budget=?, convert_currency=?, show_monthly_price=?, reminder_days=? WHERE id=1')
        .run(merged.main_currency_id ?? cur.main_currency_id, Number(merged.monthly_budget ?? 0),
          merged.convert_currency === false || merged.convert_currency === 0 ? 0 : 1,
          merged.show_monthly_price ? 1 : 0, Number(merged.reminder_days ?? 7));
      return send(res, 200, getSettings());
    }

    if (p === '/api/currencies/refresh' && req.method === 'POST') {
      const b = await parseBody(req).catch(() => ({}));
      const main = getMainCurrency();
      const base = String(b.base || main.code || 'USD').toUpperCase();
      try {
        const r = await fetch(`https://open.er-api.com/v6/latest/${base}`);
        const j = await r.json();
        if (j.result !== 'success') throw new Error('rate provider error');
        // provider gives units-per-base. We store main-per-foreign relative to OUR main currency.
        const ourMain = main.code;
        const perBase = j.rates;
        let updated = 0;
        for (const cur of db.prepare('SELECT * FROM currencies').all()) {
          const rateVsBase = perBase[cur.code];
          const mainVsBase = perBase[ourMain];
          if (rateVsBase && mainVsBase) {
            // 1 foreign = (mainVsBase / rateVsBase) main
            const rateToMain = mainVsBase / rateVsBase;
            db.prepare('UPDATE currencies SET rate_to_main=? WHERE id=?').run(rateToMain, cur.id);
            updated++;
          }
        }
        return send(res, 200, { ok: true, base, updated, time: j.time_last_update_utc });
      } catch (e) { return send(res, 502, { error: 'live rates unavailable — check network, kept manual rates' }); }
    }

    if (p === '/api/reset' && req.method === 'POST') { seedIfEmpty(true); return send(res, 200, { ok: true }); }

    return send(res, 404, { error: 'unknown route ' + p });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => console.log(`[recurra] listening on http://localhost:${PORT} (db ${DB_PATH})`));
