(() => {
  'use strict';

  /* ---------- apuja ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmt = (n) => Number(n).toLocaleString('fi-FI');
  const SUITS = ['♠', '♥', '♦', '♣'];
  const rankLabel = (c) => {
    const r = (c % 13) + 2;
    return r <= 10 ? String(r) : { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r];
  };

  /* ---------- tila ---------- */
  let ws = null;
  let backoff = 500;
  let kicked = false;
  let creds = null;
  try { creds = JSON.parse(localStorage.getItem('holdem.creds') || 'null'); } catch { creds = null; }

  let me = null;      // { name, bank, nextBonusAt }
  let lobby = null;
  let tbl = null;     // viimeisin pöytänäkymä
  let turnEnd = 0;
  let lastActionKey = '';
  let prevHand = -1;
  let prevBoardLen = 0;
  let chatLog = [];

  /* ---------- yhteys ---------- */
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      backoff = 500;
      showBanner(null);
      if (creds) sendLogin(creds.name, creds.token);
      else show('login');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    };
    ws.onclose = () => {
      if (kicked) return;
      showBanner('Yhteys katkesi. Yhdistetään uudelleen…');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
  }
  const send = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const sendLogin = (name, token) => send({ type: 'login', name, token });

  function showBanner(text) {
    const b = $('#banner');
    b.hidden = !text;
    b.textContent = text || '';
  }

  let toastTimer = null;
  function toast(text, info) {
    const t = $('#toast');
    t.textContent = text;
    t.className = 'toast' + (info ? ' info' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  function show(name) {
    for (const s of ['login', 'lobby', 'table']) $(`#screen-${s}`).hidden = s !== name;
    document.title = 'Holdem-huone';
    if (name === 'login') $('#login-name').focus();
  }

  function onMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        me = msg.user;
        if (msg.token) {
          creds = { name: msg.user.name, token: msg.token };
          localStorage.setItem('holdem.creds', JSON.stringify(creds));
        }
        updateBank();
        break;
      case 'loginError': {
        const e = $('#login-error');
        e.textContent = msg.message;
        e.hidden = false;
        creds = null;
        localStorage.removeItem('holdem.creds');
        show('login');
        break;
      }
      case 'lobby':
        lobby = msg;
        tbl = null;
        show('lobby');
        renderLobby();
        break;
      case 'state':
        tbl = msg.table;
        chatLog = tbl.chat.slice();
        turnEnd = tbl.turnLeft ? Date.now() + tbl.turnLeft : 0;
        if ($('#screen-table').hidden) { show('table'); lastActionKey = ''; prevHand = -1; }
        renderTable();
        break;
      case 'bank':
        if (me) { me.bank = msg.bank; updateBank(); }
        break;
      case 'user':
        me = msg.user;
        updateBank();
        renderLobbyBonus();
        break;
      case 'chat':
        chatLog.push(msg.msg);
        if (chatLog.length > 100) chatLog.shift();
        renderChat();
        break;
      case 'created':
        send({ type: 'join', tableId: msg.tableId });
        break;
      case 'error':
        toast(msg.message);
        break;
      case 'removed':
        tbl = null;
        toast(msg.message);
        break;
      case 'kicked':
        kicked = true;
        showBanner('Tili avattiin toisessa välilehdessä. Lataa sivu uudelleen jatkaaksesi tässä.');
        break;
      default:
    }
  }

  function updateBank() {
    if (!me) return;
    $('#lobby-bank').textContent = fmt(me.bank);
    $('#table-bank').textContent = fmt(me.bank);
    $('#lobby-name').textContent = me.name;
  }

  /* ---------- kirjautuminen ---------- */
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#login-name').value.trim();
    $('#login-error').hidden = true;
    const token = creds && creds.name.toLowerCase() === name.toLowerCase() ? creds.token : null;
    sendLogin(name, token);
  });

  /* ---------- aula ---------- */
  function renderLobby() {
    if (!lobby) return;
    updateBank();
    const list = $('#table-list');
    list.replaceChildren();
    for (const t of lobby.tables) {
      const row = el('div', 'trow');
      const left = el('div');
      left.append(el('h3', null, t.name));
      left.append(el('div', 'meta', `Blindit ${fmt(t.sb)}/${fmt(t.bb)} · sisäänosto ${fmt(t.minBuy)}–${fmt(t.maxBuy)} · ${t.players}/${t.maxSeats} pelaajaa${t.host ? ' · isäntä ' + t.host : ''}`));
      const pips = el('div', 'pips');
      for (let i = 0; i < t.maxSeats; i++) pips.append(el('span', 'pip' + (t.seated[i] ? ' on' : '')));
      left.append(pips);
      const btn = el('button', 'btn' + (lobby.seatedAt === t.id ? ' primary' : ''), lobby.seatedAt === t.id ? 'Palaa pöytään' : 'Avaa pöytä');
      btn.type = 'button';
      btn.addEventListener('click', () => send({ type: 'join', tableId: t.id }));
      row.append(left, btn);
      list.append(row);
    }

    const top = $('#top-list');
    top.replaceChildren();
    lobby.top.forEach((p, i) => {
      const li = el('li', p.name === (me && me.name) ? 'me' : '');
      li.append(el('span', null, `${i + 1}. ${p.name}`), el('span', null, fmt(p.chips)));
      top.append(li);
    });
    renderLobbyBonus();
  }

  function renderLobbyBonus() {
    if (!me) return;
    const note = $('#bonus-note');
    const wait = me.nextBonusAt - Date.now();
    if (wait > 0) {
      const h = Math.floor(wait / 3600000);
      const m = Math.ceil((wait % 3600000) / 60000);
      note.textContent = `Seuraava päivän bonus ${h > 0 ? h + ' t ' : ''}${m} min päästä. Jos pelimerkit loppuvat kokonaan, saat uuden alun.`;
    } else {
      note.textContent = 'Päivän bonus on valmiina.';
    }
  }
  $('#bonus-btn').addEventListener('click', () => send({ type: 'bonus' }));

  $('#create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    send({ type: 'createtable', name: f.get('name'), sb: Number(f.get('sb')), seats: Number(f.get('seats')) });
    e.target.reset();
  });

  /* ---------- pöytä ---------- */
  function cardEl(c, extra) {
    if (c == null) { const b = el('div', 'card back'); if (extra) b.classList.add(...extra.split(' ').filter(Boolean)); return b; }
    const s = Math.floor(c / 13);
    const d = el('div', 'card' + (s === 1 || s === 2 ? ' red' : ''));
    d.append(el('span', 'r', rankLabel(c)), el('span', 's', SUITS[s]));
    d.setAttribute('aria-label', `${rankLabel(c)} ${SUITS[s]}`);
    if (extra) d.classList.add(...extra.split(' ').filter(Boolean));
    return d;
  }

  function seatPos(i, n, mySeat) {
    const portrait = window.matchMedia('(max-width: 860px)').matches;
    const rx = portrait ? 38 : 46;
    const ry = portrait ? 45 : 46;
    const a = Math.PI / 2 + (2 * Math.PI * (i - mySeat)) / n;
    return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
  }

  function renderTable() {
    const t = tbl;
    if (!t) return;
    updateBank();
    $('#tname').textContent = t.name;
    $('#tblinds').textContent = `Blindit ${fmt(t.sb)}/${fmt(t.bb)}` + (t.custom && t.host ? ` · isäntä ${t.host}${t.isHost ? ' (sinä)' : ''}` : '');

    const m = t.me;
    const mySeat = m ? m.seat : 0;
    const n = t.maxSeats;
    const newHand = t.handNo !== prevHand;
    const boardFrom = newHand ? 0 : prevBoardLen;

    // Tulos: voittajat ja korostettavat kortit
    const winSeats = new Set();
    const best = new Set();
    const infoBySeat = {};
    if (t.result) {
      for (const h of t.result.hands) infoBySeat[h.seat] = h;
      for (const p of t.result.pots) for (const w of p.winners) {
        winSeats.add(w.seat);
        if (infoBySeat[w.seat]) infoBySeat[w.seat].best5.forEach((c) => best.add(c));
      }
    }

    /* keskusta */
    const center = $('#center');
    center.replaceChildren();
    const potline = el('div', 'potline');
    if (t.pot > 0) { potline.append(el('span', 'chip-dot'), document.createTextNode(`Potti ${fmt(t.pot)}`)); }
    center.append(potline);
    const board = el('div', 'board');
    for (let i = 0; i < 5; i++) {
      if (i < t.board.length) board.append(cardEl(t.board[i], (i >= boardFrom ? 'deal ' : '') + (best.has(t.board[i]) ? 'best' : '')));
      else board.append(el('div', 'slot'));
    }
    center.append(board);
    if (t.result) {
      const b = el('div', 'banner-win');
      for (const p of t.result.pots) for (const w of p.winners) {
        const h = infoBySeat[w.seat];
        let line = `★ ${w.name} voitti ${fmt(w.amount)}`;
        if (h && !t.result.uncontested) line += ` · ${h.handName}`;
        if (t.result.pots.length > 1) line += ` (${p.label.toLowerCase()})`;
        b.append(el('div', null, line));
      }
      center.append(b);
    } else if (t.phase === 'waiting') {
      center.append(el('div', 'waiting-note', 'Odotetaan pelaajia'));
    }

    /* paikat */
    const seatsEl = $('#seats');
    seatsEl.replaceChildren();
    t.seats.forEach((p, i) => {
      const pos = seatPos(i, n, mySeat);
      const hero = m && i === m.seat;
      const seat = el('div', 'seat');
      seat.style.left = pos.x + '%';
      seat.style.top = pos.y + '%';

      if (!p) {
        seat.classList.add('empty');
        const plate = el('div', 'plate');
        if (m) {
          seat.classList.add('locked');
          plate.append(el('div', 'pnote', 'Vapaa'));
        } else {
          const b = el('button', 'sitbtn', 'Istu tähän');
          b.type = 'button';
          b.addEventListener('click', () => openSitModal(i));
          plate.append(b);
        }
        seat.append(plate);
        seatsEl.append(seat);
        return;
      }

      if (hero) seat.classList.add('hero');
      if (t.toAct === i) seat.classList.add('turn');
      if (p.folded) seat.classList.add('folded');
      if (p.sitOut || !p.inHand) seat.classList.add('out');
      if (winSeats.has(i)) seat.classList.add('win');

      if (p.hasCards) {
        const hole = el('div', 'hole');
        const dealCls = newHand ? 'deal' : '';
        if (p.cards) for (const c of p.cards) hole.append(cardEl(c, `${dealCls} ${best.has(c) && winSeats.has(i) ? 'best' : ''} ${p.folded ? 'dim' : ''}`));
        else { hole.append(cardEl(null, dealCls)); hole.append(cardEl(null, dealCls)); }
        seat.append(hole);
      }

      const plate = el('div', 'plate');
      const name = el('div', 'pname', p.name);
      if (p.bot) name.append(el('span', 'tag', 'botti'));
      else if (p.host) name.append(el('span', 'tag', 'isäntä'));
      plate.append(name);
      plate.append(el('div', 'pstack', p.allIn ? `All-in` : fmt(p.stack)));
      let note = '';
      let act = false;
      if (p.leaving) note = 'Poistuu';
      else if (!p.connected) note = 'Yhteys poikki';
      else if (p.busted) note = 'Pelimerkit loppu';
      else if (p.sitOut) note = 'Poissa pelistä';
      else if (p.folded) note = 'Fold';
      else if (!p.inHand && t.phase !== 'waiting') note = 'Odottaa';
      else if (t.result && infoBySeat[i]) note = infoBySeat[i].handName;
      else if (p.last) { note = p.last; act = true; }
      plate.append(el('div', 'pnote' + (act ? ' act' : ''), note));
      if (t.toAct === i) {
        const bar = el('div', 'tbar');
        bar.dataset.timer = '1';
        plate.append(bar);
      }
      seat.append(plate);

      const canManage = m && (!t.custom || t.isHost);
      if (canManage && (p.bot || (t.isHost && !hero))) {
        const k = el('button', 'kick', '✕');
        k.type = 'button';
        k.title = p.bot ? 'Poista botti' : `Poista ${p.name} pöydästä`;
        k.addEventListener('click', () => {
          if (p.bot) send({ type: 'removebot', seat: i });
          else if (window.confirm(`Poistetaanko ${p.name} pöydästä?`)) send({ type: 'kick', seat: i });
        });
        seat.append(k);
      }
      seatsEl.append(seat);

      if (p.bet > 0) {
        const bet = el('div', 'bet');
        bet.style.left = (50 + (pos.x - 50) * 0.56) + '%';
        bet.style.top = (50 + (pos.y - 50) * 0.56) + '%';
        bet.append(el('span', 'chip-dot'), document.createTextNode(fmt(p.bet)));
        seatsEl.append(bet);
      }
      if (t.dealer === i) {
        const d = el('div', 'dealer-btn', 'D');
        d.title = 'Jakaja';
        d.style.left = `calc(${50 + (pos.x - 50) * 0.8}% + ${pos.x < 50 ? 34 : -34}px)`;
        d.style.top = (50 + (pos.y - 50) * 0.8) + '%';
        seatsEl.append(d);
      }
    });

    prevHand = t.handNo;
    prevBoardLen = t.board.length;

    renderLog();
    renderChat();
    renderDock();
    renderActions();
    document.title = m && m.myTurn ? '● Vuorosi – Holdem-huone' : 'Holdem-huone';
  }

  function renderLog() {
    const ol = $('#log');
    const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
    ol.replaceChildren();
    for (const line of tbl.log) ol.append(el('li', line.startsWith('—') ? 'hand' : '', line));
    if (atBottom) ol.scrollTop = ol.scrollHeight;
  }

  function renderChat() {
    const ol = $('#chat');
    ol.replaceChildren();
    for (const c of chatLog) {
      const li = el('li');
      li.append(el('b', null, c.from + ': '), document.createTextNode(c.text));
      ol.append(li);
    }
    ol.scrollTop = ol.scrollHeight;
  }

  /* ---------- alapalkki: lisätoiminnot ---------- */
  function renderDock() {
    const tools = $('#dock-tools');
    tools.replaceChildren();
    const m = tbl.me;
    if (!m) return;
    const add = (label, fn, cls) => {
      const b = el('button', 'btn ' + (cls || ''), label);
      b.type = 'button';
      b.addEventListener('click', fn);
      tools.append(b);
    };
    if (m.room > 0) add('Lisää pelimerkkejä', openAddModal);
    if (!m.busted) add(m.sitOut ? 'Palaa peliin' : 'Jää pois pelistä', () => send({ type: 'sitout', value: !m.sitOut }));
    if (tbl.seats.some((s) => !s) && (!tbl.custom || tbl.isHost)) add('Lisää botti', () => send({ type: 'addbot' }));
  }

  /* ---------- toimintopainikkeet ---------- */
  function renderActions() {
    const t = tbl;
    const m = t.me;
    const key = JSON.stringify([t.id, t.handNo, t.phase, t.toAct, t.currentBet, t.pot, m && [m.myTurn, m.stack, m.toCall, m.canRaise, m.minTo, m.maxTo, m.sitOut, m.leaving, m.busted, m.seat]]);
    if (key === lastActionKey) return;
    lastActionKey = key;

    const bar = $('#actions');
    bar.replaceChildren();
    const hint = (text, turn) => { bar.append(el('div', 'hint' + (turn ? ' turn' : ''), text)); };

    if (!m) { hint('Katselet pöytää. Valitse tyhjä paikka istuaksesi.'); return; }
    if (m.leaving) { hint('Poistut pöydästä kun käsi on päättynyt.'); return; }
    if (m.busted) { hint('Pelimerkit loppuivat. Lisää pelimerkkejä jatkaaksesi.'); return; }
    if (m.sitOut) { hint('Olet poissa pelistä. Paina "Palaa peliin" jatkaaksesi.'); return; }

    if (!m.myTurn) {
      const mine = t.seats[m.seat];
      if (t.phase === 'waiting') hint(t.seats.filter(Boolean).length < 2 ? (t.custom && !t.isHost ? 'Odotetaan toista pelaajaa.' : 'Odotetaan toista pelaajaa. Voit lisätä botin vastustajaksi.') : 'Käsi alkaa pian…');
      else if (t.phase === 'between') hint('Seuraava käsi alkaa pian…');
      else if (!mine.inHand) hint('Pääset mukaan seuraavaan käteen.');
      else if (mine.folded) hint('Olet luovuttanut tämän käden.');
      else if (mine.allIn) hint('Olet all-in. Katsotaan mitä kortit tuovat.');
      else if (t.toAct >= 0 && t.seats[t.toAct]) hint(`Vuorossa: ${t.seats[t.toAct].name}`);
      return;
    }

    hint('Sinun vuorosi', true);
    const bt = (label, cls, fn) => {
      const b = el('button', 'btn act ' + cls, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      bar.append(b);
      return b;
    };
    const act = (action, amount) => send({ type: 'action', action, amount });

    bt('Fold', 'fold', () => act('fold'));
    if (m.canCheck) bt('Check', 'call', () => act('check'));
    else bt(m.toCall >= m.stack ? `All-in ${fmt(m.stack)}` : `Call ${fmt(m.toCall)}`, 'call', () => act('call'));

    if (m.canRaise) {
      const box = el('div', 'raise-box');
      const row = el('div', 'raise-row');
      const slider = el('input');
      slider.type = 'range';
      slider.min = m.minTo;
      slider.max = m.maxTo;
      slider.step = 1;
      slider.value = m.minTo;
      slider.setAttribute('aria-label', 'Korotuksen suuruus');
      const num = el('input');
      num.type = 'number';
      num.min = m.minTo;
      num.max = m.maxTo;
      num.inputMode = 'numeric';
      num.value = m.minTo;
      num.setAttribute('aria-label', 'Korotus summaan');
      row.append(slider, num);

      const raiseBtn = el('button', 'btn act raise');
      raiseBtn.type = 'button';
      const snap = (v) => {
        v = Math.round(Number(v));
        if (!Number.isFinite(v)) v = m.minTo;
        if (m.maxTo - v < t.sb) v = m.maxTo;
        else v = Math.max(m.minTo, Math.round(v / t.sb) * t.sb);
        return Math.min(m.maxTo, Math.max(m.minTo, v));
      };
      const label = (v) => {
        if (v >= m.maxTo) return `All-in ${fmt(v)}`;
        return `${t.currentBet === 0 ? 'Bet' : 'Raise'} ${fmt(v)}`;
      };
      const set = (v) => { v = snap(v); slider.value = v; num.value = v; raiseBtn.textContent = label(v); };
      slider.addEventListener('input', () => set(slider.value));
      num.addEventListener('change', () => set(num.value));
      num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); set(num.value); raiseBtn.click(); } });
      raiseBtn.addEventListener('click', () => { const v = snap(num.value); act(v >= m.maxTo ? 'allin' : 'raise', v); });

      const presets = el('div', 'presets');
      const preset = (text, fn) => {
        const b = el('button', 'btn', text);
        b.type = 'button';
        b.addEventListener('click', () => set(fn()));
        presets.append(b);
      };
      const frac = (f) => () => t.currentBet + Math.round(f * (t.pot + m.toCall));
      preset('Min', () => m.minTo);
      preset('½ potti', frac(0.5));
      preset('¾ potti', frac(0.75));
      preset('Potti', frac(1));
      preset('All-in', () => m.maxTo);

      box.append(row, presets);
      bar.append(box, raiseBtn);
      set(m.minTo);
    }

    const tb = el('div', 'abar');
    const fill = el('i');
    fill.dataset.timer = '1';
    tb.append(fill);
    bar.append(tb);
  }

  /* ---------- ajastin ---------- */
  function tick() {
    if (tbl && turnEnd && tbl.turnTotal) {
      const frac = Math.max(0, turnEnd - Date.now()) / tbl.turnTotal;
      document.querySelectorAll('[data-timer]').forEach((e) => { e.style.width = (frac * 100).toFixed(1) + '%'; });
    } else {
      document.querySelectorAll('[data-timer]').forEach((e) => { e.style.width = '0'; });
    }
    requestAnimationFrame(tick);
  }

  /* ---------- modaali ---------- */
  let modalSubmit = null;
  function openModal({ title, text, min, max, value, okLabel, onSubmit }) {
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    const input = $('#modal-input');
    input.min = min; input.max = max; input.value = value;
    $('#modal-ok').textContent = okLabel;
    const quick = $('#modal-quick');
    quick.replaceChildren();
    const q = (label, v) => {
      const b = el('button', 'btn', label);
      b.type = 'button';
      b.addEventListener('click', () => { input.value = v; });
      quick.append(b);
    };
    q('Pienin', min);
    q('Puolet', Math.round((min + max) / 2));
    q('Suurin', max);
    modalSubmit = onSubmit;
    $('#modal').hidden = false;
    input.focus();
    input.select();
  }
  const closeModal = () => { $('#modal').hidden = true; modalSubmit = null; };
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
  $('#modal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Math.floor(Number($('#modal-input').value));
    const fn = modalSubmit;
    closeModal();
    if (fn) fn(v);
  });

  function openSitModal(seat) {
    const t = tbl;
    const max = Math.min(t.maxBuy, me.bank);
    if (me.bank < t.minBuy) {
      toast(`Tarvitset vähintään ${fmt(t.minBuy)} pelimerkkiä pankkiin. Hae päivän bonus aulasta tai valitse halvempi pöytä.`);
      return;
    }
    openModal({
      title: 'Istu pöytään',
      text: `Sisäänosto ${fmt(t.minBuy)}–${fmt(t.maxBuy)}. Pankissasi on ${fmt(me.bank)}.`,
      min: t.minBuy,
      max,
      value: Math.min(max, Math.max(t.minBuy, t.bb * 50)),
      okLabel: 'Istu',
      onSubmit: (amount) => send({ type: 'sit', tableId: t.id, seat, amount }),
    });
  }

  function openAddModal() {
    const t = tbl;
    const room = Math.min(t.me.room, me.bank);
    if (room <= 0) { toast('Pankissasi ei ole pelimerkkejä lisättäväksi.'); return; }
    openModal({
      title: 'Lisää pelimerkkejä',
      text: `Voit lisätä enintään ${fmt(room)}. Kesken käden lisäys tulee voimaan seuraavassa kädessä.`,
      min: 1,
      max: room,
      value: Math.min(room, t.bb * 50),
      okLabel: 'Lisää',
      onSubmit: (amount) => send({ type: 'addchips', amount }),
    });
  }

  /* ---------- muut tapahtumat ---------- */
  $('#btn-leave').addEventListener('click', () => {
    if (tbl && tbl.me) send({ type: 'stand' });
    send({ type: 'leaveView' });
    tbl = null;
  });

  const side = $('#side');
  $('#btn-side').addEventListener('click', () => side.classList.add('open'));
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      const which = tab.dataset.tab;
      if (which === 'close') { side.classList.remove('open'); return; }
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === tab));
      $('#log').hidden = which !== 'log';
      $('#chat').hidden = which !== 'chat';
      $('#chat-form').hidden = which !== 'chat';
      if (which === 'chat') { renderChat(); $('#chat-input').focus(); }
    });
  }
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    input.value = '';
  });

  window.addEventListener('resize', () => { if (tbl) renderTable(); });

  /* ---------- käynnistys ---------- */
  show('login');
  connect();
  requestAnimationFrame(tick);
})();
