'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Table, GameError } = require('./engine');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const START_BANK = 10000;
const DAILY_BONUS = 2000;
const RESCUE_AMOUNT = 2000;
const MAX_CUSTOM_TABLES = 12;
const NAME_RE = /^[\p{L}\p{N}_ -]{2,16}$/u;
const BLIND_CHOICES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

/* ------------------------------------------------------------------ *
 *  Tallennus (pelaajat ja pelirahat)
 * ------------------------------------------------------------------ */
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'users.json');
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* uusi tietokanta */ }
if (!db.users) db.users = {};

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), (err) => {
      if (err) return console.error('Tallennus epäonnistui:', err.message);
      fs.rename(tmp, DB_FILE, (e) => { if (e) console.error('Tallennus epäonnistui:', e.message); });
    });
  }, 500);
}
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const usersById = new Map(Object.values(db.users).map((u) => [u.id, u]));

/* ------------------------------------------------------------------ *
 *  Pöydät
 * ------------------------------------------------------------------ */
const tables = new Map();
const sessions = new Map(); // userId -> session

function makeTable(opts) {
  const t = new Table(opts, { update: onTableUpdate, cashOut });
  tables.set(t.id, t);
  return t;
}

makeTable({ id: 'aloittelijat', name: 'Aloittelijat', sb: 5, bb: 10, minBuy: 200, maxBuy: 1000, maxSeats: 6 });
makeTable({ id: 'keskitaso', name: 'Keskitaso (9 paikkaa)', sb: 25, bb: 50, minBuy: 1000, maxBuy: 5000, maxSeats: 9 });
makeTable({ id: 'isot', name: 'Isot pelit', sb: 250, bb: 500, minBuy: 10000, maxBuy: 50000, maxSeats: 6 });

function cashOut(userId, amount) {
  const u = usersById.get(userId);
  if (!u) return;
  u.bank += amount;
  saveSoon();
  const s = sessions.get(userId);
  if (s) send(s.ws, { type: 'bank', bank: u.bank });
  lobbyDirty = true;
}

function onTableUpdate(t) {
  for (const uid of t.watchers) {
    const s = sessions.get(uid);
    if (s) send(s.ws, { type: 'state', table: t.view(uid) });
  }
  lobbyDirty = true;
}

function seatedAt(userId) {
  for (const t of tables.values()) if (t.seatOf(userId) >= 0) return t;
  return null;
}

/* ------------------------------------------------------------------ *
 *  Aula
 * ------------------------------------------------------------------ */
let lobbyDirty = true;
let topCache = { at: 0, list: [] };

function leaderboard() {
  if (Date.now() - topCache.at < 5000) return topCache.list;
  const worth = new Map();
  for (const u of Object.values(db.users)) worth.set(u.id, { name: u.name, chips: u.bank });
  for (const t of tables.values()) {
    for (const p of t.seats) if (p && !p.isBot && worth.has(p.id)) worth.get(p.id).chips += p.stack + p.pendingAdd;
  }
  const list = [...worth.values()].sort((a, b) => b.chips - a.chips).slice(0, 10);
  topCache = { at: Date.now(), list };
  return list;
}

function lobbyPayload(userId) {
  const mine = seatedAt(userId);
  return {
    type: 'lobby',
    tables: [...tables.values()].map((t) => ({
      id: t.id, name: t.name, sb: t.sb, bb: t.bb, minBuy: t.minBuy, maxBuy: t.maxBuy,
      maxSeats: t.maxSeats, players: t.playerCount(), humans: t.humanCount(), custom: t.custom,
      seated: t.seats.map((p) => !!p),
      host: t.custom ? t.ownerName : null,
    })),
    top: leaderboard(),
    seatedAt: mine ? mine.id : null,
  };
}

function broadcastLobby() {
  for (const s of sessions.values()) {
    if (!s.tableId) send(s.ws, lobbyPayload(s.user.id));
  }
}
setInterval(() => { if (lobbyDirty) { lobbyDirty = false; broadcastLobby(); } }, 1000);

// Siivotaan tyhjät omat pöydät
setInterval(() => {
  for (const [id, t] of tables) {
    if (!t.custom) continue;
    if (t.humanCount() > 0 || t.watchers.size > 0) { t.lastActive = Date.now(); continue; }
    // Tyhjä huone sulkeutuu hetken kuluttua
    if (Date.now() - t.lastActive > 30 * 1000) { t.destroy(); tables.delete(id); lobbyDirty = true; }
  }
}, 10000);

/* ------------------------------------------------------------------ *
 *  HTTP (staattiset tiedostot)
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Ei löytynyt'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

/* ------------------------------------------------------------------ *
 *  WebSocket
 * ------------------------------------------------------------------ */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
const err = (ws, message) => send(ws, { type: 'error', message });

function userPayload(u) {
  return { name: u.name, bank: u.bank, nextBonusAt: (u.lastBonus || 0) + 24 * 3600 * 1000 };
}

function totalChips(u) {
  let sum = u.bank;
  const t = seatedAt(u.id);
  if (t) { const p = t.seats[t.seatOf(u.id)]; sum += p.stack + p.pendingAdd; }
  return sum;
}

function leaveView(s) {
  if (!s.tableId) return;
  const t = tables.get(s.tableId);
  if (t) {
    t.watchers.delete(s.user.id);
    // Isäntä lähti katsomosta istumatta: rooli siirtyy seuraavalle pelaajalle
    if (t.custom && t.owner === s.user.id && t.seatOf(s.user.id) < 0) {
      t.transferHost(s.user.id);
      t.changed();
    }
  }
  s.tableId = null;
}

function requireHost(t, userId) {
  if (t.custom && t.owner !== userId) throw new GameError('Vain huoneen isäntä voi tehdä tämän.');
}

function joinView(s, t) {
  leaveView(s);
  s.tableId = t.id;
  t.watchers.add(s.user.id);
  send(s.ws, { type: 'state', table: t.view(s.user.id) });
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : NaN);

function handle(ws, msg) {
  if (msg.type === 'login') return handleLogin(ws, msg);
  const s = ws.session;
  if (!s) return err(ws, 'Kirjaudu ensin sisään.');
  const u = s.user;

  // Yksinkertainen nopeusrajoitus
  const now = Date.now();
  s.hits = (s.hits || []).filter((x) => now - x < 1000);
  if (s.hits.push(now) > 15) return err(ws, 'Liian monta toimintoa, rauhoitu hetkeksi.');

  const tableOf = (id) => {
    const t = tables.get(String(id));
    if (!t) throw new GameError('Pöytää ei löydy.');
    return t;
  };

  try {
    switch (msg.type) {
      case 'join': {
        const t = tableOf(msg.tableId);
        joinView(s, t);
        break;
      }
      case 'leaveView': {
        leaveView(s);
        send(ws, lobbyPayload(u.id));
        break;
      }
      case 'sit': {
        const t = tableOf(msg.tableId);
        const other = seatedAt(u.id);
        if (other && other !== t) throw new GameError(`Olet jo pelaamassa pöydässä "${other.name}". Poistu siitä ensin (poistuminen tapahtuu käden päätyttyä).`);
        const amount = int(msg.amount);
        if (!(amount >= t.minBuy && amount <= t.maxBuy)) throw new GameError(`Sisäänosto on oltava ${t.minBuy}–${t.maxBuy}.`);
        if (u.bank < amount) throw new GameError('Pankissasi ei ole tarpeeksi pelimerkkejä.');
        u.bank -= amount;
        try { t.sit({ id: u.id, name: u.name, isBot: false }, int(msg.seat), amount); }
        catch (e) { u.bank += amount; throw e; }
        saveSoon();
        send(ws, { type: 'bank', bank: u.bank });
        if (s.tableId !== t.id) joinView(s, t);
        break;
      }
      case 'stand': {
        const t = seatedAt(u.id);
        if (!t) throw new GameError('Et ole missään pöydässä.');
        t.standUp(u.id);
        break;
      }
      case 'action': {
        const t = seatedAt(u.id);
        if (!t) throw new GameError('Et ole pöydässä.');
        t.act(u.id, String(msg.action), int(msg.amount));
        break;
      }
      case 'addchips': {
        const t = seatedAt(u.id);
        if (!t) throw new GameError('Et ole pöydässä.');
        const amount = int(msg.amount);
        if (!(amount > 0)) throw new GameError('Virheellinen summa.');
        if (u.bank < amount) throw new GameError('Pankissasi ei ole tarpeeksi pelimerkkejä.');
        u.bank -= amount;
        try { t.addChips(u.id, amount); } catch (e) { u.bank += amount; throw e; }
        saveSoon();
        send(ws, { type: 'bank', bank: u.bank });
        break;
      }
      case 'sitout': {
        const t = seatedAt(u.id);
        if (!t) throw new GameError('Et ole pöydässä.');
        t.setSitOut(u.id, !!msg.value);
        break;
      }
      case 'addbot': {
        const t = seatedAt(u.id);
        if (!t) throw new GameError('Istu ensin pöytään lisätäksesi botin.');
        requireHost(t, u.id);
        t.addBot();
        break;
      }
      case 'removebot': {
        const t = seatedAt(u.id);
        if (!t) throw new GameError('Et ole pöydässä.');
        requireHost(t, u.id);
        t.removeBot(int(msg.seat));
        break;
      }
      case 'kick': {
        const t = seatedAt(u.id);
        if (!t || !t.custom) throw new GameError('Et ole omassa huoneessa.');
        requireHost(t, u.id);
        const seat = int(msg.seat);
        const target = t.seats[seat];
        if (target && target.id === u.id) throw new GameError('Et voi poistaa itseäsi. Käytä Poistu-painiketta.');
        const kickedId = t.kick(seat);
        const ks = sessions.get(kickedId);
        if (ks) {
          leaveView(ks);
          send(ks.ws, { type: 'removed', message: 'Huoneen isäntä poisti sinut pöydästä. Pelimerkit palautuvat pankkiin käden päätyttyä.' });
          send(ks.ws, lobbyPayload(kickedId));
        }
        break;
      }
      case 'chat': {
        const t = s.tableId && tables.get(s.tableId);
        if (!t) throw new GameError('Avaa ensin pöytä.');
        const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!text) break;
        if (now - (s.lastChat || 0) < 700) throw new GameError('Chat: kirjoitat liian nopeasti.');
        s.lastChat = now;
        t.chat.push({ from: u.name, text, t: now });
        if (t.chat.length > 100) t.chat.shift();
        for (const uid of t.watchers) {
          const w = sessions.get(uid);
          if (w) send(w.ws, { type: 'chat', msg: { from: u.name, text, t: now } });
        }
        break;
      }
      case 'bonus': {
        const dayOk = now - (u.lastBonus || 0) >= 24 * 3600 * 1000;
        const broke = totalChips(u) < 100 && now - (u.lastRescue || 0) >= 10 * 60 * 1000;
        if (dayOk) { u.bank += DAILY_BONUS; u.lastBonus = now; }
        else if (broke) { u.bank += RESCUE_AMOUNT; u.lastRescue = now; }
        else throw new GameError('Päivän bonus ei ole vielä saatavilla.');
        saveSoon();
        send(ws, { type: 'user', user: userPayload(u) });
        lobbyDirty = true;
        break;
      }
      case 'createtable': {
        const custom = [...tables.values()].filter((t) => t.custom).length;
        if (custom >= MAX_CUSTOM_TABLES) throw new GameError('Omien pöytien enimmäismäärä on täynnä.');
        const name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
        if (name.length < 3) throw new GameError('Pöydän nimessä on oltava vähintään 3 merkkiä.');
        const sb = int(msg.sb);
        if (!BLIND_CHOICES.includes(sb)) throw new GameError('Virheellinen blindi.');
        const seats = int(msg.seats);
        if (!(seats >= 2 && seats <= 9)) throw new GameError('Paikkojen määrä on 2–9.');
        const id = 'p-' + crypto.randomBytes(4).toString('hex');
        makeTable({ id, name, sb, bb: sb * 2, minBuy: sb * 2 * 20, maxBuy: sb * 2 * 100, maxSeats: seats, custom: true, owner: u.id, ownerName: u.name });
        lobbyDirty = true;
        send(ws, { type: 'created', tableId: id });
        break;
      }
      default:
        throw new GameError('Tuntematon viesti.');
    }
  } catch (e) {
    if (e instanceof GameError) return err(ws, e.message);
    console.error('Virhe viestin käsittelyssä:', e);
    err(ws, 'Palvelinvirhe.');
  }
}

function handleLogin(ws, msg) {
  const name = String(msg.name || '').replace(/\s+/g, ' ').trim();
  if (!NAME_RE.test(name)) return send(ws, { type: 'loginError', message: 'Nimessä pitää olla 2–16 merkkiä (kirjaimia, numeroita, väli, _ tai -).' });
  const key = name.toLowerCase();
  let u = db.users[key];
  let token = null;
  if (!u) {
    if (Object.keys(db.users).length >= 5000) return send(ws, { type: 'loginError', message: 'Palvelin on täynnä.' });
    token = crypto.randomBytes(18).toString('hex');
    u = { id: crypto.randomBytes(8).toString('hex'), name, tokenHash: hash(token), bank: START_BANK, created: Date.now(), lastBonus: 0, lastRescue: 0 };
    db.users[key] = u;
    usersById.set(u.id, u);
    saveSoon();
  } else {
    if (!msg.token || hash(msg.token) !== u.tokenHash) {
      return send(ws, { type: 'loginError', message: 'Nimi on jo käytössä. Valitse toinen nimi.' });
    }
  }

  const old = sessions.get(u.id);
  if (old && old.ws !== ws) {
    send(old.ws, { type: 'kicked' });
    detach(old);
    old.ws.close();
  }

  const s = { ws, user: u, tableId: null, hits: [], lastChat: 0 };
  sessions.set(u.id, s);
  ws.session = s;
  send(ws, { type: 'welcome', user: userPayload(u), token });

  const t = seatedAt(u.id);
  if (t) {
    t.setConnected(u.id, true);
    joinView(s, t);
  } else {
    send(ws, lobbyPayload(u.id));
  }
}

function detach(s) {
  if (sessions.get(s.user.id) === s) sessions.delete(s.user.id);
  const t = seatedAt(s.user.id);
  if (t && sessions.get(s.user.id) === undefined) t.setConnected(s.user.id, false);
  leaveView(s);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    handle(ws, msg);
  });
  ws.on('close', () => { if (ws.session) detach(ws.session); });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

process.on('SIGTERM', () => { if (saveTimer) { clearTimeout(saveTimer); } try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch { /* ei väliä */ } process.exit(0); });
process.on('SIGINT', () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch { /* ei väliä */ } process.exit(0); });

server.listen(PORT, () => console.log(`Holdem-palvelin käynnissä: http://localhost:${PORT}`));
