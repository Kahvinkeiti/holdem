'use strict';
// Korttien numerointi: 0..51. rank = (c % 13) + 2 (2..14, 14 = A), suit = floor(c / 13) (0..3)

const HAND_NAMES = [
  'Korkea kortti', 'Pari', 'Kaksi paria', 'Kolmoset', 'Suora',
  'Väri', 'Täyskäsi', 'Neloset', 'Värisuora',
];
const B = 15;
const B5 = B ** 5;

const rank = (c) => (c % 13) + 2;
const suit = (c) => Math.floor(c / 13);

/** Pisteyttää täsmälleen viiden kortin käden. Suurempi luku = parempi käsi. */
function score5(cards) {
  const rs = cards.map(rank).sort((a, b) => b - a);
  const flush = cards.every((c) => suit(c) === suit(cards[0]));

  let straightHigh = 0;
  if (new Set(rs).size === 5) {
    if (rs[0] - rs[4] === 4) straightHigh = rs[0];
    else if (rs[0] === 14 && rs[1] === 5 && rs[2] === 4 && rs[3] === 3 && rs[4] === 2) straightHigh = 5;
  }

  const counts = {};
  for (const r of rs) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a] || b - a);
  const pattern = groups.map((g) => counts[g]).join('');

  let cat;
  let tb;
  if (straightHigh && flush) { cat = 8; tb = [straightHigh]; }
  else if (pattern === '41') { cat = 7; tb = groups; }
  else if (pattern === '32') { cat = 6; tb = groups; }
  else if (flush) { cat = 5; tb = rs; }
  else if (straightHigh) { cat = 4; tb = [straightHigh]; }
  else if (pattern === '311') { cat = 3; tb = groups; }
  else if (pattern === '221') { cat = 2; tb = groups; }
  else if (pattern === '2111') { cat = 1; tb = groups; }
  else { cat = 0; tb = rs; }

  let s = cat;
  for (let i = 0; i < 5; i++) s = s * B + (tb[i] || 0);
  return s;
}

function combinations(arr, k, start = 0, cur = [], out = []) {
  if (cur.length === k) { out.push(cur.slice()); return out; }
  for (let i = start; i <= arr.length - (k - cur.length); i++) {
    cur.push(arr[i]);
    combinations(arr, k, i + 1, cur, out);
    cur.pop();
  }
  return out;
}

/** Paras viiden kortin käsi 5–7 kortista. */
function bestHand(cards) {
  let best = -1;
  let bestSet = null;
  for (const combo of combinations(cards, 5)) {
    const s = score5(combo);
    if (s > best) { best = s; bestSet = combo; }
  }
  const cat = Math.floor(best / B5);
  return { score: best, cat, name: HAND_NAMES[cat], best5: bestSet.slice() };
}

module.exports = { bestHand, score5, HAND_NAMES, rank, suit };
