'use strict';
// Testit: käsien arviointi + satunnaispelaajien simulaatio, joka tarkistaa pelimerkkien säilymisen.
const assert = require('assert');
const { bestHand, score5 } = require('../evaluator');
const { Table, GameError } = require('../engine');

/* ---------- kädenarvioinnin yksikkötestit ---------- */
const C = (s) => { // "As" -> kortti
  const r = '23456789TJQKA'.indexOf(s[0]) ;
  const su = 'shdc'.indexOf(s[1]);
  return su * 13 + r;
};
const H = (str) => bestHand(str.split(' ').map(C));
const order = [
  'As Ks Qs Js Ts 2d 3c',   // värisuora (royal)
  '9h 9d 9s 9c Ad 2c 3c',   // neloset
  'Kh Kd Ks 2c 2d 7h 8h',   // täyskäsi
  'Ah 9h 7h 4h 2h Kd Kc',   // väri
  '5h 6d 7s 8c 9d Ah Ac',   // suora
  'Qh Qd Qs 2c 5d 7h 9h',   // kolmoset
  'Jh Jd 4s 4c Ad 7h 9h',   // kaksi paria
  'Th Td 4s 3c Ad 7h 9h',   // pari
  'Ah Kd 4s 3c 9d 7h 2h',   // korkea kortti
];
for (let i = 0; i < order.length - 1; i++) {
  assert(H(order[i]).score > H(order[i + 1]).score, `järjestys ${i}: ${order[i]} > ${order[i + 1]}`);
}
assert.strictEqual(H('Ah 2d 3s 4c 5d 9h Kh').name, 'Suora', 'pyörä A-5');
assert(H('6h 2d 3s 4c 5d 9h Kh').score > H('Ah 2d 3s 4c 5d 9h Kh').score, '6-suora voittaa pyörän');
assert(H('Ah Ad Ks Qc Jd 9h 2h').score > H('Ah Ad Ks Qc 9d 8h 2h').score, 'kicker ratkaisee');
assert.strictEqual(H('Ah Kh Qh Jh 9h 2d 3c').name, 'Väri');
assert.strictEqual(score5(['2s', '2h', '2d', '2c', '3s'].map(C)) > score5(['As', 'Ah', 'Ad', 'Kc', 'Ks'].map(C)), true, 'neloset > täyskäsi');
console.log('✔ kädenarviointi OK');

/* ---------- simulaatio ---------- */
const FAST = { turn: 50, next: 1, nextShowdown: 1, runout: 1, auto: 1, botMin: 0, botMax: 1, start: 1, disconnect: 1e9 };

function runTable(label, seatsCount, hands, humanFuzz) {
  return new Promise((resolve, reject) => {
    const cashed = [];
    let initialTotal = 0;
    let errors = 0;
    let invalidAttempts = 0;
    let handsDone = 0;
    let t;

    const checkInvariant = () => {
      let sum = 0;
      for (const p of t.seats) if (p) {
        assert(p.stack >= 0, 'negatiivinen pino');
        assert(Number.isInteger(p.stack), 'ei-kokonaisluku pino');
        sum += p.stack + p.pendingAdd;
      }
      sum += t.seats.reduce((s, p) => s + (p ? 0 : 0), 0);
      const pot = t.isActive() ? t.totalPot() : 0; // käden jälkeen potti on jo jaettu pinoihin
      // pino + pot (pot sisältää jo panostetut) - luodut = alkuperäinen
      const total = sum + pot + cashed.reduce((a, b) => a + b, 0) - t.minted;
      assert.strictEqual(total, initialTotal, `${label}: pelimerkit eivät säily (${total} vs ${initialTotal}) kädessä ${t.handNo}, vaihe ${t.phase}`);
    };

    let lastHandNo = 0;
    const hooks = {
      cashOut: (id, amt) => { cashed.push(amt); },
      update: (tb) => {
        try {
          checkInvariant();
          // konkurssiin menneet "ihmiset" ostavat lisää (ulkopuolelta tuleva raha kirjataan alkusummaan)
          for (const p of tb.seats) {
            if (p && !p.isBot && p.busted && p.stack === 0 && !tb._topping) {
              tb._topping = true;
              initialTotal += 500;
              try { tb.addChips(p.id, 500); } catch (e) { initialTotal -= 500; }
              tb._topping = false;
            }
          }
          if (tb.phase === 'between' && tb.handNo !== lastHandNo) {
            lastHandNo = tb.handNo; handsDone++;
            // voittojen summa = potti
            const res = tb.result;
            assert(res, 'tulos puuttuu');
            // tarkistetaan että potit täsmäävät pelattuun summaan
            const potSum = res.pots.reduce((s, p) => s + p.amount, 0);
            const winSum = res.pots.reduce((s, p) => s + p.winners.reduce((a, w) => a + w.amount, 0), 0);
            assert.strictEqual(potSum, winSum, 'voitot eivät vastaa pottia');
            if (handsDone >= hands) { tb.destroy(); resolve({ label, handsDone, errors, invalidAttempts }); return; }
          }
          // satunnaispelaaja ("ihminen") toimii
          if (tb.isActive() && tb.toAct >= 0) {
            const p = tb.seats[tb.toAct];
            if (p && !p.isBot && humanFuzz && !tb._pending) {
              tb._pending = true;
              setImmediate(() => {
                tb._pending = false;
                if (!tb.isActive() || tb.toAct < 0) return;
                const q = tb.seats[tb.toAct];
                if (!q || q.isBot) return;
                fuzzAct(tb, q);
              });
            }
          }
        } catch (e) { reject(e); }
      },
    };

    function fuzzAct(tb, q) {
      const choices = ['fold', 'check', 'call', 'raise', 'allin', 'raise', 'call', 'call', 'bogus'];
      const type = choices[Math.floor(Math.random() * choices.length)];
      let amount = 0;
      if (type === 'raise') {
        const r = Math.random();
        const maxTo = q.bet + q.stack;
        amount = r < 0.2 ? Math.floor(Math.random() * 10) : r < 0.5 ? Math.floor(tb.currentBet + tb.minRaise + Math.random() * 3 * tb.bb) : Math.floor(Math.random() * (maxTo + 5));
      }
      const before = JSON.stringify(tb.seats.map((p) => p && [p.stack, p.bet, p.total]));
      try {
        tb.act(q.id, type, amount);
      } catch (e) {
        if (!(e instanceof GameError)) { reject(e); return; }
        invalidAttempts++;
        const after = JSON.stringify(tb.seats.map((p) => p && [p.stack, p.bet, p.total]));
        try { assert.strictEqual(before, after, 'virheellinen toiminto muutti tilaa!'); } catch (err) { reject(err); return; }
        // varmistetaan että peli jatkuu: tee turvallinen toiminto
        try { tb.act(q.id, q.bet >= tb.currentBet ? 'check' : 'fold', 0); } catch (e2) { reject(e2); }
      }
    }

    t = new Table({
      id: label, name: label, sb: 5, bb: 10, minBuy: 200, maxBuy: 1000, maxSeats: seatsCount,
      allowBotsOnly: true, timing: FAST,
    }, hooks);

    // alkutila
    let n = 0;
    for (let i = 0; i < seatsCount; i++) {
      const isBot = !(humanFuzz && i % 2 === 0);
      const stack = 200 + Math.floor(Math.random() * 800);
      initialTotal += stack;
      t.sit({ id: (isBot ? 'bot-' : 'hum-') + i, name: (isBot ? 'B' : 'H') + i, isBot }, i, stack);
      n++;
    }
    // botit "ostavat" lisää -> minted laskee niiden osalta; ihmiset eivät osta lisää
    // (minted-laskuri alkaa nollasta; sit() ei muuta sitä)
    setTimeout(() => reject(new Error(`${label}: aikakatkaisu (${handsDone}/${hands} kättä)`)), 120000);
  });
}

(async () => {
  const jobs = [
    runTable('bots-6', 6, 400, false),
    runTable('bots-9', 9, 300, false),
    runTable('hu-fuzz', 2, 300, true),
    runTable('fuzz-5', 5, 400, true),
    runTable('fuzz-9', 9, 300, true),
    runTable('fuzz-3', 3, 400, true),
  ];
  try {
    const res = await Promise.all(jobs);
    for (const r of res) console.log(`✔ ${r.label}: ${r.handsDone} kättä, ${r.invalidAttempts} hylättyä virhetoimintoa, pelimerkit säilyivät`);
    console.log('Kaikki testit läpäisty.');
    process.exit(0);
  } catch (e) {
    console.error('✘ TESTI EPÄONNISTUI:', e.stack || e);
    process.exit(1);
  }
})();
