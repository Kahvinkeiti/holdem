'use strict';
const crypto = require('crypto');
const { bestHand } = require('./evaluator');

const DEFAULT_TIMING = {
  turn: 25000,          // pelaajan vuoron kesto
  next: 5000,           // tauko käsien välillä
  nextShowdown: 7000,   // tauko, kun kortit paljastettiin
  runout: 1500,         // viive kun jaetaan loput kortit all-inin jälkeen
  auto: 500,            // viive automaattitoiminnolle (poissa oleva pelaaja)
  botMin: 800,
  botMax: 1800,
  start: 2000,          // viive ensimmäisen käden alkuun
  disconnect: 120000,   // kauanko yhteydetön pelaaja säilyttää paikkansa
};

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

const BOT_NAMES = ['Aino', 'Eino', 'Helmi', 'Onni', 'Siiri', 'Väinö', 'Lilja', 'Toivo', 'Kerttu', 'Aarne'];
const ACTIVE = ['preflop', 'flop', 'turn', 'river'];

function shuffledDeck() {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

class Table {
  constructor(opts, hooks) {
    this.id = opts.id;
    this.name = opts.name;
    this.sb = opts.sb;
    this.bb = opts.bb;
    this.minBuy = opts.minBuy;
    this.maxBuy = opts.maxBuy;
    this.maxSeats = opts.maxSeats || 6;
    this.custom = !!opts.custom;
    this.owner = opts.owner || null;          // huoneen isäntä (käyttäjän id), vain omilla pöydillä
    this.ownerName = opts.ownerName || null;
    this.allowBotsOnly = !!opts.allowBotsOnly; // testejä varten
    this.T = Object.assign({}, DEFAULT_TIMING, opts.timing || {});
    this.hooks = hooks;

    this.seats = new Array(this.maxSeats).fill(null);
    this.watchers = new Set();   // palvelin hallinnoi
    this.chat = [];
    this.lastActive = Date.now();

    this.dealer = -1;
    this.phase = 'waiting';      // waiting | preflop | flop | turn | river | between
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.toAct = -1;
    this.handNo = 0;
    this.deadline = 0;
    this.result = null;
    this.revealedAll = false;
    this.logs = [];
    this.timers = {};
    this.minted = 0;             // pelimerkit, jotka botit ovat "ostaneet" lisää (testejä varten)
  }

  /* ---------- apuja ---------- */

  schedule(name, ms, fn) {
    this.cancel(name);
    this.timers[name] = setTimeout(() => { this.timers[name] = null; fn(); }, ms);
  }
  cancel(name) {
    if (this.timers[name]) { clearTimeout(this.timers[name]); this.timers[name] = null; }
  }
  destroy() { Object.keys(this.timers).forEach((k) => this.cancel(k)); }
  changed() { this.hooks.update(this); }
  log(text) { this.logs.push(text); if (this.logs.length > 80) this.logs.shift(); }

  isActive() { return ACTIVE.includes(this.phase); }
  seatOf(id) { return this.seats.findIndex((p) => p && p.id === id); }
  humanCount() { return this.seats.filter((p) => p && !p.isBot).length; }
  playerCount() { return this.seats.filter(Boolean).length; }
  totalPot() { return this.seats.reduce((s, p) => s + (p ? p.total : 0), 0); }
  eligibleSeats() {
    const out = [];
    this.seats.forEach((p, i) => { if (p && !p.sitOut && p.connected && p.stack > 0) out.push(i); });
    return out;
  }
  canAct() { return this.seats.filter((p) => p && p.inHand && !p.folded && !p.allIn); }
  nextIn(list, from) {
    const n = this.maxSeats;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (list.includes(i)) return i;
    }
    return list[0];
  }

  /* ---------- istuminen ---------- */

  sit(info, seat, amount) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.maxSeats) fail('Virheellinen paikka.');
    if (this.seats[seat]) fail('Paikka on jo varattu.');
    if (this.seatOf(info.id) >= 0) fail('Olet jo tässä pöydässä.');
    if (!Number.isInteger(amount)) fail('Virheellinen summa.');
    if (!info.isBot && (amount < this.minBuy || amount > this.maxBuy)) {
      fail(`Sisäänosto on oltava ${this.minBuy}–${this.maxBuy}.`);
    }
    this.seats[seat] = {
      id: info.id, name: info.name, isBot: !!info.isBot,
      stack: amount, bet: 0, total: 0,
      folded: false, allIn: false, acted: false, raiseLocked: false,
      cards: [], inHand: false, revealed: false,
      sitOut: false, busted: false, leaving: false, connected: true, dcOut: false,
      timeouts: 0, lastAction: '', pendingAdd: 0,
    };
    this.log(`${info.name} istui pöytään.`);
    if (this.custom && !this.owner && !info.isBot) {
      this.owner = info.id; this.ownerName = info.name;
      this.log(`${info.name} on nyt huoneen isäntä.`);
    }
    this.lastActive = Date.now();
    this.maybeStart();
    this.changed();
  }

  maybeStart() {
    if (this.phase === 'waiting' && this.eligibleSeats().length >= 2 && !this.timers.next) {
      this.schedule('next', this.T.start, () => this.startHand());
    }
  }

  addBot() {
    const seat = this.seats.findIndex((p) => !p);
    if (seat < 0) fail('Pöytä on täynnä.');
    const used = new Set(this.seats.filter(Boolean).map((p) => p.name));
    const free = BOT_NAMES.filter((n) => !used.has(n));
    if (!free.length) fail('Ei vapaita bottinimiä.');
    const name = free[crypto.randomInt(free.length)];
    const stack = Math.min(this.maxBuy, this.minBuy * 2);
    this.minted += stack;
    this.sit({ id: 'bot-' + crypto.randomBytes(4).toString('hex'), name, isBot: true }, seat, stack);
  }

  removeBot(seat) {
    const p = this.seats[seat];
    if (!p || !p.isBot) fail('Paikalla ei ole bottia.');
    if (this.isActive() && p.inHand) {
      p.leaving = true;
      if (this.toAct === seat) { this.cancel('bot'); this.schedule('bot', 200, () => this.autoAct(seat, false)); }
      this.changed();
    } else {
      this.removeSeat(seat);
      this.cleanupBots();
      this.changed();
    }
  }

  removeSeat(i) {
    const p = this.seats[i];
    if (!p) return;
    if (!p.isBot) this.hooks.cashOut(p.id, p.stack + p.pendingAdd, this);
    this.seats[i] = null;
    this.cancel('dc' + p.id);
    this.log(`${p.name} poistui pöydästä.`);
    this.lastActive = Date.now();
    if (!p.isBot && p.id === this.owner) this.transferHost(p.id);
  }

  /** Siirtää isännän roolin seuraavalle istuvalle ihmispelaajalle (tai tyhjentää sen). */
  transferHost(excludeId) {
    if (!this.custom) return;
    const next = this.seats.find((q) => q && !q.isBot && q.id !== excludeId);
    this.owner = next ? next.id : null;
    this.ownerName = next ? next.name : null;
    if (next) this.log(`${next.name} on nyt huoneen isäntä.`);
  }

  /** Isäntä poistaa ihmispelaajan pöydästä. Palauttaa poistetun käyttäjän id:n. */
  kick(seat) {
    const p = this.seats[seat];
    if (!p || p.isBot) fail('Paikalla ei ole pelaajaa.');
    const id = p.id;
    this.log(`Isäntä poisti pelaajan ${p.name}.`);
    this.standUp(id);
    return id;
  }

  cleanupBots() {
    if (this.allowBotsOnly) return;
    if (this.humanCount() > 0) return;
    this.seats.forEach((p, i) => { if (p && p.isBot) this.seats[i] = null; });
    if (this.playerCount() === 0 && this.phase !== 'waiting') {
      ['turn', 'bot', 'run', 'next'].forEach((n) => this.cancel(n));
      this.phase = 'waiting';
      this.board = [];
      this.result = null;
      this.toAct = -1;
      this.deadline = 0;
    }
  }

  standUp(id) {
    const i = this.seatOf(id);
    if (i < 0) fail('Et ole pöydässä.');
    const p = this.seats[i];
    if (this.isActive() && p.inHand) {
      p.leaving = true;
      this.log(`${p.name} poistuu kierroksen jälkeen.`);
      if (this.toAct === i) {
        this.cancel('turn');
        this.schedule('turn', 200, () => this.autoAct(i, false));
      }
    } else {
      this.removeSeat(i);
      this.cleanupBots();
    }
    this.changed();
  }

  addChips(id, amount) {
    const i = this.seatOf(id);
    if (i < 0) fail('Et ole pöydässä.');
    const p = this.seats[i];
    if (!Number.isInteger(amount) || amount <= 0) fail('Virheellinen summa.');
    const room = this.maxBuy - (p.stack + p.pendingAdd);
    if (amount > room) fail(room <= 0 ? 'Pinosi on jo pöydän maksimissa.' : `Voit lisätä enintään ${room}.`);
    if (this.isActive() && p.inHand) {
      p.pendingAdd += amount;
      this.log(`${p.name} lisää pelimerkkejä seuraavaan käteen.`);
    } else {
      p.stack += amount;
      if (p.busted) { p.busted = false; p.sitOut = false; }
      this.log(`${p.name} lisäsi ${amount} pelimerkkiä.`);
      this.maybeStart();
    }
    this.changed();
  }

  setSitOut(id, value) {
    const i = this.seatOf(id);
    if (i < 0) fail('Et ole pöydässä.');
    const p = this.seats[i];
    if (!value && p.stack === 0 && p.pendingAdd === 0) fail('Lisää ensin pelimerkkejä.');
    p.sitOut = !!value;
    p.dcOut = false;
    p.timeouts = 0;
    if (!value) { p.busted = false; this.maybeStart(); }
    this.log(`${p.name} ${value ? 'jää pois pelistä' : 'palaa peliin'}.`);
    if (value && this.toAct === i) { this.cancel('turn'); this.schedule('turn', 200, () => this.autoAct(i, false)); }
    this.changed();
  }

  setConnected(id, connected) {
    const i = this.seatOf(id);
    if (i < 0) return;
    const p = this.seats[i];
    p.connected = connected;
    if (!connected) {
      if (!(this.isActive() && p.inHand)) { p.sitOut = true; p.dcOut = true; }
      this.schedule('dc' + id, this.T.disconnect, () => {
        const j = this.seatOf(id);
        if (j >= 0 && !this.seats[j].connected) this.standUp(id);
      });
      if (this.toAct === i) { this.cancel('turn'); this.schedule('turn', this.T.auto, () => this.autoAct(i, false)); }
    } else {
      this.cancel('dc' + id);
      if (p.dcOut) { p.sitOut = false; p.dcOut = false; }
      this.maybeStart();
    }
    this.changed();
  }

  /* ---------- käden kulku ---------- */

  startHand() {
    this.cancel('next');
    if (this.phase !== 'waiting' && this.phase !== 'between') return;

    for (const p of this.seats) {
      if (!p) continue;
      if (p.pendingAdd) { p.stack += p.pendingAdd; p.pendingAdd = 0; }
      if (p.isBot && p.stack < this.bb * 10) {
        const add = this.minBuy - p.stack;
        p.stack += add; this.minted += add;
        p.busted = false; p.sitOut = false;
      }
      if (p.busted && p.stack > 0) { p.busted = false; p.sitOut = false; }
    }

    const elig = this.eligibleSeats();
    this.result = null;
    if (elig.length < 2) {
      this.phase = 'waiting';
      this.toAct = -1;
      this.board = [];
      this.seats.forEach((p) => { if (p) { p.cards = []; p.inHand = false; p.bet = 0; p.total = 0; p.folded = false; p.allIn = false; p.revealed = false; p.lastAction = ''; } });
      this.changed();
      return;
    }

    this.handNo++;
    this.board = [];
    this.deck = shuffledDeck();
    this.revealedAll = false;
    this.seats.forEach((p, i) => {
      if (!p) return;
      Object.assign(p, {
        bet: 0, total: 0, folded: false, allIn: false, acted: false, raiseLocked: false,
        cards: [], revealed: false, lastAction: '', inHand: elig.includes(i),
      });
    });

    this.dealer = this.nextIn(elig, this.dealer);
    let sbI;
    let bbI;
    if (elig.length === 2) { sbI = this.dealer; bbI = this.nextIn(elig, sbI); }
    else { sbI = this.nextIn(elig, this.dealer); bbI = this.nextIn(elig, sbI); }

    this.log(`— Käsi #${this.handNo} —`);
    this.post(sbI, this.sb, 'SB');
    this.post(bbI, this.bb, 'BB');
    for (const i of elig) this.seats[i].cards = [this.deck.pop(), this.deck.pop()];

    this.phase = 'preflop';
    this.currentBet = this.bb;
    this.minRaise = this.bb;
    this.afterAction(bbI);
  }

  post(i, blind, label) {
    const p = this.seats[i];
    const amt = this.commit(p, blind);
    p.lastAction = `${label} ${amt}`;
    this.log(`${p.name} maksaa ${label === 'SB' ? 'pienen' : 'ison'} blindin ${amt}.`);
  }

  commit(p, amt) {
    amt = Math.max(0, Math.min(amt, p.stack));
    p.stack -= amt; p.bet += amt; p.total += amt;
    if (p.stack === 0) p.allIn = true;
    return amt;
  }

  nextActor(from) {
    const canAct = this.canAct();
    if (canAct.length === 0) return -1;
    if (canAct.length === 1 && canAct[0].bet >= this.currentBet) return -1;
    const n = this.maxSeats;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      const p = this.seats[i];
      if (p && p.inHand && !p.folded && !p.allIn && (!p.acted || p.bet < this.currentBet)) return i;
    }
    return -1;
  }

  afterAction(from) {
    const alive = [];
    this.seats.forEach((p, i) => { if (p && p.inHand && !p.folded) alive.push(i); });
    if (alive.length === 1) return this.finishUncontested(alive[0]);
    const next = this.nextActor(from);
    if (next >= 0) { this.toAct = next; return this.prompt(); }
    return this.endBetting();
  }

  prompt() {
    const i = this.toAct;
    const p = this.seats[i];
    this.cancel('turn'); this.cancel('bot');
    if (p.isBot) {
      this.deadline = 0;
      const d = this.T.botMin + Math.random() * (this.T.botMax - this.T.botMin);
      this.schedule('bot', d, () => this.botAct(i));
    } else if (p.leaving || p.sitOut || !p.connected) {
      this.deadline = 0;
      this.schedule('turn', this.T.auto, () => this.autoAct(i, false));
    } else {
      this.deadline = Date.now() + this.T.turn;
      this.schedule('turn', this.T.turn, () => this.autoAct(i, true));
    }
    this.changed();
  }

  autoAct(i, timedOut) {
    if (this.toAct !== i || !this.isActive()) return;
    const p = this.seats[i];
    if (!p) return;
    if (timedOut) {
      p.timeouts++;
      if (p.timeouts >= 2) { p.sitOut = true; this.log(`${p.name} jäi pois pelistä (aikakatkaisu).`); }
    }
    this.doAction(i, p.bet >= this.currentBet ? 'check' : 'fold', 0, true);
  }

  act(id, type, amount) {
    const i = this.seatOf(id);
    if (i < 0 || i !== this.toAct || !this.isActive()) fail('Ei ole vuorosi.');
    this.doAction(i, type, amount, false);
  }

  doAction(i, type, amount, auto) {
    const p = this.seats[i];
    const toCall = Math.max(0, this.currentBet - p.bet);
    const maxTo = p.bet + p.stack;
    const label = [];

    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'Fold';
        this.log(`${p.name} luovuttaa.`);
        break;
      case 'check':
        if (toCall > 0) fail('Et voi checkata, sinun täytyy maksaa tai luovuttaa.');
        p.lastAction = 'Check';
        this.log(`${p.name} checkkaa.`);
        break;
      case 'call': {
        if (toCall === 0) { p.lastAction = 'Check'; this.log(`${p.name} checkkaa.`); break; }
        const amt = this.commit(p, toCall);
        p.lastAction = p.allIn ? `All-in ${p.bet}` : `Call ${amt}`;
        this.log(`${p.name} ${p.allIn ? 'menee all-in (call)' : 'maksaa'} ${amt}.`);
        break;
      }
      case 'raise':
      case 'allin': {
        let to = type === 'allin' ? maxTo : Math.floor(Number(amount));
        if (!Number.isFinite(to)) fail('Virheellinen summa.');
        if (to > maxTo) to = maxTo;
        if (to <= this.currentBet) {
          if (type === 'allin' && to === maxTo) {
            // all-in joka ei yllä korotukseen: käytännössä call
            const amt = this.commit(p, to - p.bet);
            p.lastAction = `All-in ${p.bet}`;
            this.log(`${p.name} menee all-in ${p.bet}.`);
            void amt;
            break;
          }
          fail('Korotuksen on oltava suurempi kuin nykyinen panos.');
        }
        if (p.raiseLocked) fail('Et voi enää korottaa tässä kierroksessa, vain maksaa tai luovuttaa.');
        const minTo = this.currentBet === 0
          ? Math.min(this.bb, maxTo)
          : Math.min(this.currentBet + this.minRaise, maxTo);
        if (to < minTo) fail(`Pienin sallittu korotus on ${minTo}.`);

        const wasBet = this.currentBet === 0;
        this.commit(p, to - p.bet);
        const raiseSize = to - this.currentBet;
        const full = raiseSize >= this.minRaise;
        if (full) this.minRaise = raiseSize;
        this.currentBet = to;
        for (const q of this.seats) {
          if (!q || q === p || !q.inHand || q.folded || q.allIn) continue;
          if (full) { q.acted = false; q.raiseLocked = false; }
          else if (q.acted) q.raiseLocked = true;
        }
        p.lastAction = p.allIn ? `All-in ${to}` : `${wasBet ? 'Bet' : 'Raise'} ${to}`;
        this.log(`${p.name} ${p.allIn ? 'menee all-in' : wasBet ? 'panostaa' : 'korottaa'} ${to}.`);
        break;
      }
      default:
        fail('Tuntematon toiminto.');
    }
    void label;
    p.acted = true;
    if (!auto) p.timeouts = 0;
    this.cancel('turn'); this.cancel('bot');
    this.afterAction(i);
  }

  /* ---------- katujen vaihto ---------- */

  endBetting() {
    this.toAct = -1;
    this.deadline = 0;
    this.cancel('turn'); this.cancel('bot');
    if (this.phase === 'river') return this.showdown();
    if (this.canAct().length <= 1 && !this.revealedAll) {
      // Kukaan ei voi enää panostaa: näytetään kortit ja jaetaan loput hitaasti.
      this.revealAll();
      this.changed();
      this.schedule('run', this.T.runout, () => this.dealAndContinue());
      return;
    }
    this.dealAndContinue();
  }

  revealAll() {
    this.revealedAll = true;
    for (const p of this.seats) if (p && p.inHand && !p.folded) p.revealed = true;
  }

  dealAndContinue() {
    this.dealStreet();
    const next = this.nextActor(this.dealer);
    if (next >= 0) { this.toAct = next; this.prompt(); return; }
    this.changed();
    this.schedule('run', this.T.runout, () => this.endBetting());
  }

  dealStreet() {
    for (const p of this.seats) {
      if (!p) continue;
      p.bet = 0; p.acted = false; p.raiseLocked = false; p.lastAction = '';
    }
    this.currentBet = 0;
    this.minRaise = this.bb;
    this.deck.pop(); // polta kortti
    if (this.phase === 'preflop') {
      this.phase = 'flop';
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else if (this.phase === 'flop') {
      this.phase = 'turn'; this.board.push(this.deck.pop());
    } else if (this.phase === 'turn') {
      this.phase = 'river'; this.board.push(this.deck.pop());
    }
  }

  /* ---------- potit ja voitonjako ---------- */

  buildPots() {
    const contrib = [];
    this.seats.forEach((p, i) => { if (p && p.total > 0) contrib.push({ p, i }); });
    const live = contrib.filter((x) => !x.p.folded);
    const levels = [...new Set(live.map((x) => x.p.total))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lv of levels) {
      let amount = 0;
      for (const { p } of contrib) amount += Math.max(0, Math.min(p.total, lv) - Math.min(p.total, prev));
      const eligible = live.filter((x) => x.p.total >= lv).map((x) => x.i);
      const last = pots[pots.length - 1];
      if (last && last.eligible.join() === eligible.join()) last.amount += amount;
      else pots.push({ amount, eligible });
      prev = lv;
    }
    const top = levels[levels.length - 1] || 0;
    let extra = 0;
    for (const { p } of contrib) extra += Math.max(0, p.total - top);
    if (extra > 0 && pots.length) pots[pots.length - 1].amount += extra;
    return pots;
  }

  finishUncontested(i) {
    const p = this.seats[i];
    const pot = this.totalPot();
    p.stack += pot;
    this.result = {
      uncontested: true,
      pots: [{ label: 'Potti', amount: pot, winners: [{ seat: i, name: p.name, amount: pot }] }],
      hands: [],
    };
    this.log(`${p.name} voittaa potin ${pot} (muut luovuttivat).`);
    this.endHand();
  }

  showdown() {
    const n = this.maxSeats;
    const hands = {};
    const liveSeats = [];
    this.seats.forEach((p, i) => {
      if (p && p.inHand && !p.folded) {
        liveSeats.push(i);
        p.revealed = true;
        hands[i] = bestHand(p.cards.concat(this.board));
      }
    });

    const resPots = [];
    this.buildPots().forEach((pot, k) => {
      let best = -1;
      let winners = [];
      for (const i of pot.eligible) {
        const s = hands[i].score;
        if (s > best) { best = s; winners = [i]; } else if (s === best) winners.push(i);
      }
      winners.sort((a, b) => ((a - this.dealer - 1 + n) % n) - ((b - this.dealer - 1 + n) % n));
      const share = Math.floor(pot.amount / winners.length);
      let rem = pot.amount - share * winners.length;
      const w = winners.map((i) => {
        const amount = share + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
        this.seats[i].stack += amount;
        return { seat: i, name: this.seats[i].name, amount };
      });
      resPots.push({ label: k === 0 ? 'Pääpotti' : `Sivupotti ${k}`, amount: pot.amount, winners: w });
      for (const x of w) this.log(`${x.name} voittaa ${x.amount} (${hands[x.seat].name}).`);
    });

    this.result = {
      uncontested: false,
      pots: resPots,
      hands: liveSeats.map((i) => ({ seat: i, name: this.seats[i].name, handName: hands[i].name, best5: hands[i].best5 })),
    };
    this.endHand();
  }

  endHand() {
    ['turn', 'bot', 'run'].forEach((n) => this.cancel(n));
    this.phase = 'between';
    this.toAct = -1;
    this.deadline = 0;
    this.seats.forEach((p, i) => {
      if (!p) return;
      if (p.leaving) { this.removeSeat(i); return; }
      if (p.stack === 0 && p.pendingAdd === 0 && p.inHand) {
        p.busted = true; p.sitOut = true;
        if (!p.isBot) this.log(`${p.name} menetti kaikki pelimerkit.`);
      }
      if (!p.connected) { p.sitOut = true; p.dcOut = true; }
    });
    this.cleanupBots();
    this.lastActive = Date.now();
    this.changed();
    const wait = this.result && !this.result.uncontested ? this.T.nextShowdown : this.T.next;
    this.schedule('next', wait, () => this.startHand());
  }

  /* ---------- botti ---------- */

  handStrength(p) {
    const ranks = p.cards.map((c) => (c % 13) + 2);
    const hi = Math.max(...ranks);
    const lo = Math.min(...ranks);
    const suited = Math.floor(p.cards[0] / 13) === Math.floor(p.cards[1] / 13);
    if (this.board.length === 0) {
      if (hi === lo) return 0.55 + ((hi - 2) / 12) * 0.4;
      let s = ((hi - 2) / 12) * 0.42 + ((lo - 2) / 12) * 0.22;
      if (suited) s += 0.07;
      if (hi - lo <= 2) s += 0.05;
      return Math.min(0.85, s);
    }
    const ev = bestHand(p.cards.concat(this.board));
    const byCat = [0.12, 0.42, 0.72, 0.82, 0.88, 0.9, 0.95, 0.99, 1];
    let s = byCat[ev.cat];
    if (ev.cat === 1) {
      const boardRanks = this.board.map((c) => (c % 13) + 2);
      const mine = hi === lo || boardRanks.includes(hi) || boardRanks.includes(lo);
      s = mine ? 0.42 + (Math.max(hi === lo ? hi : 0, boardRanks.includes(hi) ? hi : 0, boardRanks.includes(lo) ? lo : 0) - 2) / 12 * 0.2 : 0.2;
    }
    if (ev.cat === 0 && hi >= 13) s += 0.08;
    return s;
  }

  botAct(i) {
    const p = this.seats[i];
    if (!p || this.toAct !== i || !this.isActive()) return;
    if (p.leaving) return this.doAction(i, p.bet >= this.currentBet ? 'check' : 'fold', 0, true);
    const toCall = Math.min(this.currentBet - p.bet, p.stack);
    const pot = this.totalPot();
    const strength = Math.max(0, Math.min(1, this.handStrength(p) + (Math.random() - 0.5) * 0.16));
    const maxTo = p.bet + p.stack;
    const canRaise = !p.raiseLocked && maxTo > this.currentBet;
    const r = Math.random();

    const raiseTo = (frac) => {
      const minTo = this.currentBet === 0 ? Math.min(this.bb, maxTo) : Math.min(this.currentBet + this.minRaise, maxTo);
      let to = this.currentBet + Math.round(frac * (pot + toCall));
      to = Math.round(to / this.sb) * this.sb;
      return Math.max(minTo, Math.min(maxTo, to));
    };

    try {
      if (toCall <= 0) {
        if (canRaise && strength > 0.7 && r < 0.7) return this.doAction(i, 'raise', raiseTo(0.5 + Math.random() * 0.4), true);
        if (canRaise && strength > 0.45 && r < 0.25) return this.doAction(i, 'raise', raiseTo(0.4), true);
        if (canRaise && r < 0.04) return this.doAction(i, 'raise', raiseTo(0.6), true);
        return this.doAction(i, 'check', 0, true);
      }
      const odds = toCall / (pot + toCall);
      if (canRaise && strength > 0.85 && r < 0.6) return this.doAction(i, 'raise', raiseTo(0.6 + Math.random() * 0.4), true);
      if (strength > odds + 0.1 || r < 0.06) return this.doAction(i, 'call', 0, true);
      return this.doAction(i, 'fold', 0, true);
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      return this.doAction(i, p.bet >= this.currentBet ? 'check' : 'fold', 0, true);
    }
  }

  /* ---------- näkymä pelaajalle ---------- */

  view(viewerId) {
    const mi = viewerId ? this.seatOf(viewerId) : -1;
    const me = mi >= 0 ? this.seats[mi] : null;

    const seats = this.seats.map((p, i) => {
      if (!p) return null;
      const own = i === mi;
      const show = own || (p.revealed && !p.folded && p.cards.length > 0);
      return {
        name: p.name, bot: p.isBot, stack: p.stack, bet: p.bet,
        folded: p.folded, allIn: p.allIn, sitOut: p.sitOut, inHand: p.inHand,
        leaving: p.leaving, connected: p.connected, busted: p.busted,
        last: p.lastAction, host: !p.isBot && p.id === this.owner,
        hasCards: p.inHand && p.cards.length > 0 && (!p.folded || own),
        cards: show && p.cards.length ? p.cards : null,
      };
    });

    let meInfo = null;
    if (me) {
      const toCall = Math.max(0, this.currentBet - me.bet);
      const maxTo = me.bet + me.stack;
      const minTo = this.currentBet === 0
        ? Math.min(this.bb, maxTo)
        : Math.min(this.currentBet + this.minRaise, maxTo);
      meInfo = {
        seat: mi,
        stack: me.stack,
        myTurn: this.toAct === mi && this.isActive(),
        toCall: Math.min(toCall, me.stack),
        canCheck: toCall === 0,
        canRaise: !me.raiseLocked && maxTo > this.currentBet,
        minTo, maxTo,
        sitOut: me.sitOut, leaving: me.leaving, busted: me.busted,
        pendingAdd: me.pendingAdd,
        room: Math.max(0, this.maxBuy - (me.stack + me.pendingAdd)),
      };
    }

    return {
      id: this.id, name: this.name, sb: this.sb, bb: this.bb,
      minBuy: this.minBuy, maxBuy: this.maxBuy, maxSeats: this.maxSeats,
      phase: this.phase, handNo: this.handNo,
      board: this.board, pot: this.isActive() ? this.totalPot() : 0, currentBet: this.currentBet,
      dealer: this.dealer, toAct: this.toAct,
      turnLeft: this.deadline ? Math.max(0, this.deadline - Date.now()) : 0,
      turnTotal: this.T.turn,
      seats, me: meInfo, result: this.result,
      log: this.logs.slice(-40),
      chat: this.chat.slice(-50),
      custom: this.custom,
      host: this.ownerName,
      isHost: !!viewerId && this.owner === viewerId,
    };
  }
}

module.exports = { Table, GameError, DEFAULT_TIMING };
