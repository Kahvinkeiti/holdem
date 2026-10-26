'use strict';
// Päästä päähän -testi: käynnistää palvelimen, kirjautuu kahtena pelaajana WebSocketilla ja pelaa käsiä.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 3456;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-e2e-'));
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const c = { ws, name, state: null, lobby: null, user: null, token: null, errors: [], states: 0 };
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'welcome') { c.user = m.user; c.token = m.token; }
      if (m.type === 'lobby') c.lobby = m;
      if (m.type === 'state') { c.state = m.table; c.states++; }
      if (m.type === 'bank') c.user.bank = m.bank;
      if (m.type === 'error') c.errors.push(m.message);
      if (m.type === 'loginError') c.loginError = m.message;
      c.last = m;
    });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'login', name, token })); setTimeout(() => resolve(c), 300); });
    ws.on('error', reject);
    c.send = (o) => ws.send(JSON.stringify(o));
  });
}

async function waitFor(fn, ms = 15000, what = 'ehto') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(50); }
  throw new Error('Aikakatkaisu: ' + what);
}

(async () => {
  try {
    await sleep(800);
    const a = await client('Maija');
    const b = await client('Pekka');
    assert(a.user && a.user.bank === 10000, 'aloituspankki 10000');
    assert(a.lobby && a.lobby.tables.length >= 3, 'aula näyttää pöydät');

    // sama nimi ilman tunnistetta hylätään
    const evil = await client('maija');
    assert(evil.loginError, 'nimen kaappaus estetty');

    // liittyminen ja istuminen
    a.send({ type: 'join', tableId: 'aloittelijat' });
    b.send({ type: 'join', tableId: 'aloittelijat' });
    await waitFor(() => a.state && b.state, 3000, 'pöytätila');
    a.send({ type: 'sit', tableId: 'aloittelijat', seat: 0, amount: 1000 });
    b.send({ type: 'sit', tableId: 'aloittelijat', seat: 3, amount: 500 });
    await waitFor(() => a.state.me && b.state.me, 3000, 'istuminen');
    assert.strictEqual(a.user.bank, 9000, 'pankista vähennettiin sisäänosto');
    // väärä sisäänosto
    b.send({ type: 'sit', tableId: 'aloittelijat', seat: 4, amount: 5 });
    await sleep(200);
    assert(b.errors.length > 0, 'virheellinen sisäänosto hylätty');

    // peli alkaa itsestään
    await waitFor(() => a.state.phase === 'preflop', 8000, 'käsi alkaa');
    // vastustajan kortteja ei vuoda
    const seatB_inA = a.state.seats[3];
    assert.strictEqual(seatB_inA.cards, null, 'vastustajan kortit piilossa');
    assert(a.state.seats[0].cards && a.state.seats[0].cards.length === 2, 'omat kortit näkyvät');

    // pelataan 6 kättä: vuorossa oleva call/check
    let played = 0;
    let lastHand = 0;
    const t0 = Date.now();
    while (played < 6 && Date.now() - t0 < 120000) {
      for (const c of [a, b]) {
        const m = c.state && c.state.me;
        if (m && m.myTurn) {
          c.send({ type: 'action', action: m.canCheck ? 'check' : 'call' });
          await sleep(60);
        }
      }
      if (a.state.handNo !== lastHand && a.state.phase === 'between') { lastHand = a.state.handNo; played++; }
      await sleep(40);
    }
    assert(played >= 6, 'pelattiin kädet');

    // pelimerkkien säilyminen: pankki + pino = alkuperäinen
    await waitFor(() => a.state.phase === 'between' || a.state.phase === 'preflop', 5000);
    const total = (c, buy) => c.user.bank + c.state.me.stack + c.state.me.pendingAdd;
    // a: 10000 alussa, b: 10000 alussa → yhteensä 20000
    assert.strictEqual(total(a) + total(b), 20000, 'pelimerkit säilyvät pankin ja pöydän välillä');

    // chat
    a.send({ type: 'chat', text: 'Hei <b>kaikki</b>' });
    await waitFor(() => b.last && b.last.type === 'chat', 2000, 'chat');
    assert.strictEqual(b.last.msg.text, 'Hei <b>kaikki</b>', 'chat välitetään sellaisenaan (selain käyttää textContent)');

    // botti
    a.send({ type: 'addbot' });
    await waitFor(() => a.state.seats.some((s) => s && s.bot), 3000, 'botti istuu');

    // poistuminen palauttaa pelimerkit pankkiin
    a.send({ type: 'stand' });
    b.send({ type: 'stand' });
    await waitFor(() => !a.state.me && !b.state.me, 40000, 'poistuminen');
    await sleep(300);
    assert.strictEqual(a.user.bank + b.user.bank, 20000, 'pankit yhteensä 20000 poistumisen jälkeen');

    // uudelleenkirjautuminen tunnisteella
    const a2 = await client('Maija', a.token);
    assert(a2.user && !a2.loginError, 'uudelleenkirjautuminen tunnisteella');
    assert.strictEqual(a2.user.bank, a.user.bank, 'pankki säilyi');

    console.log('✔ E2E: kirjautuminen, istuminen, pelaaminen, chat, botti, poistuminen ja pankki toimivat');
    console.log(`  pankit: Maija ${a.user.bank}, Pekka ${b.user.bank}`);
    srv.kill('SIGTERM');
    await sleep(300);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
    assert(Object.keys(saved.users).length === 2, 'tallennus toimii');
    console.log('✔ Tallennus levylle toimii');
    process.exit(0);
  } catch (e) {
    console.error('✘ E2E EPÄONNISTUI:', e.stack || e);
    srv.kill('SIGKILL');
    process.exit(1);
  }
})();
