import { spawn } from 'node:child_process';
const port = 38917;
const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), RECURRA_DB: ':memory:' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
async function waitUp(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start: ' + out);
}
const checks = [];
try {
  await waitUp();
  for (const p of ['/api/health', '/api/overview', '/api/subscriptions', '/api/stats', '/api/reminders?days=7']) {
    const d = new Date(); const cal = `/api/calendar?year=${d.getFullYear()}&month=${d.getMonth() + 1}`;
    void cal;
    const r = await fetch(`http://localhost:${port}${p}`);
    const j = await r.json();
    checks.push([p, r.status, Array.isArray(j) ? `array(${j.length})` : Object.keys(j).slice(0, 6).join(',')]);
    if (!r.ok) throw new Error(p + ' -> ' + r.status);
  }
  const calR = await fetch(`http://localhost:${port}/api/calendar`);
  if (!calR.ok) throw new Error('calendar failed');
  const subs = await (await fetch(`http://localhost:${port}/api/subscriptions`)).json();
  if (!subs.length) throw new Error('expected seeded subscriptions');
  const created = await (await fetch(`http://localhost:${port}/api/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Smoke Test', price: 5, cycle: 3, frequency: 1, next_payment: new Date().toISOString().slice(0, 10) }) })).json();
  if (!created.id) throw new Error('create failed');
  await fetch(`http://localhost:${port}/api/subscriptions/${created.id}`, { method: 'DELETE' });
  console.log('smoke OK:');
  for (const c of checks) console.log(' ', c.join(' | '));
} finally { child.kill(); }
