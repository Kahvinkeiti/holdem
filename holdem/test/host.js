'use strict';
const { spawn } = require('child_process');
const path = require('path'); const fs = require('fs'); const os = require('os');
const assert = require('assert'); const WebSocket = require('ws');
const PORT = 3457;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-host-'));
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const c = { state: null, lobby: null, errors: [], msgs: [] };
    ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m.type);
      if (m.type === 'lobby') c.lobby = m; if (m.type === 'state') c.state = m.table;
      if (m.type === 'error') c.errors.push(m.message); if (m.type === 'created') c.created = m.tableId; });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'login', name })); setTimeout(() => resolve(c), 250); });
    ws.on('error', reject); c.send = (o) => ws.send(JSON.stringify(o));
  });
}
async function waitFor(fn, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await sleep(50); } throw new Error('Aikakatkaisu: ' + what); }
(async () => {
  try {
    await sleep(800);
    const a = await client('Maija'); const b = await client('Pekka');
    a.send({ type: 'createtable', name: 'Perjantain pelit', sb: 5, seats: 6 });
    await waitFor(() => a.created, 3000, 'huone luotu');
    const id = a.created;
    a.send({ type: 'join', tableId: id });
    await waitFor(() => a.state, 3000, 'huone auki');
    a.send({ type: 'sit', tableId: id, seat: 0, amount: 200 * 1 });
    await waitFor(() => a.state.me, 3000, 'isäntä istuu');
    assert.strictEqual(a.state.host, 'Maija'); assert.strictEqual(a.state.isHost, true);
    b.send({ type: 'join', tableId: id }); await waitFor(() => b.state, 3000, 'b katsoo');
    assert.strictEqual(b.state.isHost, false);
    b.send({ type: 'sit', tableId: id, seat: 2, amount: 200 });
    await waitFor(() => b.state.me, 3000, 'b istuu');
    // vain isäntä saa lisätä botin
    b.send({ type: 'addbot' }); await sleep(200);
    assert(b.errors.some((e) => e.includes('isäntä')), 'ei-isäntä ei saa lisätä bottia');
    // isäntä poistaa pelaajan -> b saa viestin ja palaa aulaan
    a.send({ type: 'kick', seat: 2 });
    await waitFor(() => b.msgs.includes('removed'), 3000, 'kick');
    await waitFor(() => !a.state.seats[2], 3000, 'b poistui');
    // b istuu uudelleen, sitten isäntä poistuu -> isännyys siirtyy b:lle
    b.send({ type: 'join', tableId: id }); await sleep(200);
    b.send({ type: 'sit', tableId: id, seat: 2, amount: 200 });
    await waitFor(() => b.state && b.state.me, 3000, 'b istuu uudelleen');
    a.send({ type: 'stand' });
    await waitFor(() => b.state.isHost === true && b.state.host === 'Pekka', 4000, 'isännyys siirtyi');
    console.log('✔ isäntä siirtyi Maijalta Pekalle');
    // viimeinen poistuu -> huone sulkeutuu
    b.send({ type: 'stand' }); b.send({ type: 'leaveView' }); a.send({ type: 'leaveView' });
    await waitFor(() => { return false; }, 100, 'x').catch(() => {});
    const probe = await client('Katsoja');
    await waitFor(() => !(probe.lobby && probe.lobby.tables.some((t) => t.id === id)) , 1, '').catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) { const p = await client('Katsoja' + Math.floor(Math.random() * 1e6)); if (!p.lobby.tables.some((t) => t.id === id)) break; await sleep(3000); }
    const fin = await client('Loppu' + Date.now() % 1000);
    assert(!fin.lobby.tables.some((t) => t.id === id), 'tyhjä huone sulkeutui');
    console.log('✔ tyhjä huone sulkeutui', Math.round((Date.now() - t0) / 1000), 's kuluttua');
    srv.kill('SIGKILL'); process.exit(0);
  } catch (e) { console.error('✘ HOST-TESTI EPÄONNISTUI:', e.stack || e); srv.kill('SIGKILL'); process.exit(1); }
})();
