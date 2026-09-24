// Trapped-shorts / trapped-longs analysis on COMEX silver futures (SI1!, 1H), with gold, the dollar
// and daily open interest as context. Pre-registered split: develop on 2025, validate on 2026.
// Usage: node silver-traps.js --from 2025-01-01        (needs SI1!_60, GC1!_60, DXY_60 candles,
//                                                       SI1!_OI_D, SI1!_D, and footprints for SI1!/GC1! 1H)
const fs = require('fs');
const path = require('path');
const T = require('./trap-analysis');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, '..', 'results', 'silver');
const SPLIT_T = Date.parse('2026-01-01T00:00:00Z') / 1000; // before: development, after: validation
const COST_PER_SIDE = 0.0002; // futures: ~1 tick slippage + commission
const MAX_HOLD = 24; // ~1 session
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);

// CME session: 18:00-17:00 New York time. The session's "day" is the New York date 6h after the bar time.
const nyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
const nyParts = (t) => { const p = Object.fromEntries(nyFmt.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 }; };
const sessionKey = (t) => nyParts(t + 6 * 3600).date;
const phaseOf = (t) => { const h = nyParts(t).hour; if (h >= 18 || h < 2) return 'Asia (18-02 ET)'; if (h < 7) return 'London (02-07 ET)'; if (h < 10) return 'COMEX open (07-10 ET)'; if (h < 14) return 'NY (10-14 ET)'; return 'late NY (14-17 ET)'; };

function loadFutures(sym) {
  const bars = T.loadSeries(sym, '60');
  bars.forEach((b) => { b.day = sessionKey(b.t); b.ny = nyParts(b.t); });
  let prevDay = null; let lo = Infinity; let hi = -Infinity; let psl = null; let psh = null; let weekStart = false;
  bars.forEach((b, i) => {
    if (b.day !== prevDay) { if (prevDay !== null) { psl = lo; psh = hi; } prevDay = b.day; lo = Infinity; hi = -Infinity; b.sessionStart = true; }
    lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); b.psl = psl; b.psh = psh;
    b.weekOpen = i > 0 && b.t - bars[i - 1].t > 6 * 3600; // first bar after the weekend pause
  });
  return bars;
}

function simulate(bars, idx, dir, entry, stop, k) {
  const risk = Math.abs(entry - stop); const target = entry + dir * k * risk; const costR = (2 * COST_PER_SIDE * entry) / risk;
  for (let j = idx + 1; j < bars.length && j <= idx + MAX_HOLD; j += 1) {
    const { o, h, l, c } = bars[j];
    const so = dir === 1 ? o <= stop : o >= stop; const to = dir === 1 ? o >= target : o <= target;
    if (so || to) return (dir * (o - entry)) / risk - costR;
    if (dir === 1 ? l <= stop : h >= stop) return -1 - costR;
    if (dir === 1 ? h >= target : l <= target) return k - costR;
    if (j === idx + MAX_HOLD) return (dir * (c - entry)) / risk - costR;
  }
  return null;
}

// ---------- data ----------
const si = loadFutures('SI1!');
const gc = loadFutures('GC1!');
const gIdx = new Map(gc.map((b, i) => [b.t, i]));
const dxy = JSON.parse(fs.readFileSync(path.join(DATA, 'DXY_60.json'))); const dIdx = new Map(dxy.map((b, i) => [b[0], i]));
const oiD = JSON.parse(fs.readFileSync(path.join(DATA, 'SI1!_OI_D.json'))); const siD = JSON.parse(fs.readFileSync(path.join(DATA, 'SI1!_D.json')));
const oiByDate = new Map(oiD.map((x) => [new Date(x[0] * 1000).toISOString().slice(0, 10), x[4]]));
const closeByDate = new Map(siD.map((x) => [new Date(x[0] * 1000).toISOString().slice(0, 10), x[4]]));
const oiDates = [...oiByDate.keys()].sort();
// open-interest build over the 3 completed days before `date`: OI up and price down = shorts building
function oiContext(date) {
  const i = oiDates.findIndex((d) => d >= date) - 1; // last completed day
  if (i < 3) return null;
  const d0 = oiDates[i]; const d3 = oiDates[i - 3];
  return { oiChg: oiByDate.get(d0) / oiByDate.get(d3) - 1, pxChg: (closeByDate.get(d0) || 0) / (closeByDate.get(d3) || 1) - 1 };
}

// ---------- events ----------
const seen = new Map();
T.detectEvents(si, 'SI1!', '60').filter((e) => e.type === 'shorts_trapped' || e.type === 'longs_trapped').forEach((e) => {
  const key = `${e.type}|${e.idx}`;
  if (!seen.has(key) || e.trappedVol > seen.get(key).trappedVol) seen.set(key, e);
});
const events = [];
for (const e of seen.values()) {
  const b = si[e.idx]; const bd = si[e.idx - e.barsToFail];
  if (si.slice(e.idx - e.barsToFail, e.idx + 1).some((x) => x.weekOpen)) continue; // no weekend gaps inside the trap
  const entry = b.c;
  const stop = Math.abs(entry - e.stopPrice) >= T.MIN_RISK_ATR * b.atr ? e.stopPrice : entry - e.dir * T.MIN_RISK_ATR * b.atr;
  const gi = gIdx.get(b.t); const gd = gIdx.get(bd.t); const di = dIdx.get(b.t); const dd = dIdx.get(bd.t);
  if (gi === undefined || gd === undefined) continue;
  const g = gc[gi]; const oi = oiContext(b.day);
  const ev = {
    type: e.type, dir: e.dir, t: b.t, w: b.t < SPLIT_T ? 'dev' : 'val', level: e.level, levelKind: e.levelKind, barsToFail: e.barsToFail, trappedVol: e.trappedVol,
    reclaimDelta: e.failDeltaPct, phase: phaseOf(b.t), entry, stop, riskPct: (100 * Math.abs(entry - stop)) / entry,
    goldHolds: e.dir === 1 ? g.c > g.psl : g.c < g.psh, // gold did not break its own prior-session level
    goldWithTrade: e.dir === 1 ? g.c > gc[gd].c : g.c < gc[gd].c, // gold moved the trade's way during the trap
    dxyAgainst: di !== undefined && dd !== undefined ? (e.dir === 1 ? dxy[di][4] < dxy[dd][4] : dxy[di][4] > dxy[dd][4]) : null, // dollar moved the trade's way
    rsVsGold: e.dir * ((b.c / bd.c - 1) - (g.c / gc[gd].c - 1)), // silver vs gold during the trap, signed by trade direction
    oiBuild: oi ? (e.dir === 1 ? oi.oiChg > 0 && oi.pxChg < 0 : oi.oiChg > 0 && oi.pxChg > 0) : null, // positions built on the trapped side
    oiChg: oi ? oi.oiChg : null,
    R1: simulate(si, e.idx, e.dir, entry, stop, 1), R2: simulate(si, e.idx, e.dir, entry, stop, 2), R3: simulate(si, e.idx, e.dir, entry, stop, 3),
    up24: e.idx + 24 < si.length ? e.dir * (si[e.idx + 24].c - b.c) > 0 : null,
  };
  events.push(ev);
}
// random entries (both directions), per window
const random = []; let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const first = si.findIndex((b) => b.atr && b.delta !== null);
for (let k = 0; k < events.length * 3; k += 1) {
  const idx = first + Math.floor(rnd() * (si.length - first - 1)); const b = si[idx]; if (!b.atr || b.delta === null) continue;
  const dir = rnd() < 0.5 ? 1 : -1; const entry = b.c; const s0 = dir === 1 ? b.l - T.STOP_BUFFER_ATR * b.atr : b.h + T.STOP_BUFFER_ATR * b.atr;
  const stop = Math.abs(entry - s0) >= T.MIN_RISK_ATR * b.atr ? s0 : entry - dir * T.MIN_RISK_ATR * b.atr;
  random.push({ dir, w: b.t < SPLIT_T ? 'dev' : 'val', R1: simulate(si, idx, dir, entry, stop, 1), R2: simulate(si, idx, dir, entry, stop, 2), R3: simulate(si, idx, dir, entry, stop, 3), up24: idx + 24 < si.length ? dir * (si[idx + 24].c - b.c) > 0 : null });
}

// ---------- report ----------
const st = (evs) => {
  const a = evs.map((e) => e.R1).filter((x) => x !== null); const b2 = evs.map((e) => e.R2).filter((x) => x !== null); const b3 = evs.map((e) => e.R3).filter((x) => x !== null); const u = evs.map((e) => e.up24).filter((x) => x !== null);
  if (!a.length) return 'n=0';
  return `n=${String(a.length).padEnd(4)} 1R win ${(100 * a.filter((x) => x > 0).length / a.length).toFixed(0).padStart(3)}%  1R ${f(mean(a)).padStart(5)}  2R ${f(mean(b2)).padStart(5)}  3R ${f(mean(b3)).padStart(5)}  right-in-24 ${(100 * u.filter(Boolean).length / u.length).toFixed(0).padStart(3)}%`;
};
const row = (label, evs) => { console.log(`  ${label.padEnd(40)} dev 2025: ${st(evs.filter((e) => e.w === 'dev'))}`); console.log(`  ${''.padEnd(40)} val 2026: ${st(evs.filter((e) => e.w === 'val'))}`); };
console.log(`\nSilver futures 1H: ${events.length} trap events (${events.filter((e) => e.w === 'dev').length} in 2025, ${events.filter((e) => e.w === 'val').length} in 2026)`);
for (const [type, dirName] of [['shorts_trapped', 'LONG'], ['longs_trapped', 'SHORT']]) {
  const E = events.filter((e) => e.type === type); const R = random.filter((r) => r.dir === (type === 'shorts_trapped' ? 1 : -1));
  console.log(`\n=============== ${type.toUpperCase()} -> ${dirName} trades ===============`);
  row('random entries, same direction', R);
  row('all events', E);
  row('trapped vol >= 1x avg', E.filter((e) => e.trappedVol >= 1));
  row('trapped vol >= 1x & 3-8 bars to reclaim', E.filter((e) => e.trappedVol >= 1 && e.barsToFail >= 3));
  row('level = prior session low/high', E.filter((e) => e.levelKind !== 'pivot'));
  row('level = 1H pivot', E.filter((e) => e.levelKind === 'pivot'));
  console.log('  -- session phase of the reclaim candle --');
  for (const ph of ['Asia (18-02 ET)', 'London (02-07 ET)', 'COMEX open (07-10 ET)', 'NY (10-14 ET)', 'late NY (14-17 ET)']) row(ph, E.filter((e) => e.phase === ph));
  console.log('  -- gold / dollar context --');
  row('gold holds its prior-session level', E.filter((e) => e.goldHolds)); row('gold broke its prior-session level', E.filter((e) => !e.goldHolds));
  row('gold moved with the trade during trap', E.filter((e) => e.goldWithTrade)); row('gold moved against', E.filter((e) => !e.goldWithTrade));
  row('dollar moved the trade\'s way', E.filter((e) => e.dxyAgainst === true)); row('dollar moved against', E.filter((e) => e.dxyAgainst === false));
  row('silver outperformed gold in trap', E.filter((e) => e.rsVsGold > 0)); row('silver underperformed gold', E.filter((e) => e.rsVsGold <= 0));
  console.log('  -- daily open interest (3 days into the trap) --');
  row('OI up while price moved to the level', E.filter((e) => e.oiBuild === true)); row('no such build-up', E.filter((e) => e.oiBuild === false));
  console.log('  -- combination (pre-stated): London/COMEX open + gold holds + trapped vol >= 1x --');
  row('combo', E.filter((e) => (e.phase.startsWith('London') || e.phase.startsWith('COMEX')) && e.goldHolds && e.trappedVol >= 1));
}
fs.mkdirSync(OUT, { recursive: true });
const cols = ['type', 'time', 'window', 'level', 'levelKind', 'barsToFail', 'trappedVol_x_avg', 'reclaimDelta', 'phase', 'goldHolds', 'goldWithTrade', 'dollarWithTrade', 'rsVsGold', 'oiBuild', 'oiChg3d', 'entry', 'stop', 'riskPct', 'R_1R', 'R_2R', 'R_3R', 'rightIn24'];
fs.writeFileSync(path.join(OUT, 'events.csv'), [cols.join(',')].concat(events.sort((a, b) => a.t - b.t).map((e) => [e.type, new Date(e.t * 1000).toISOString().slice(0, 16).replace('T', ' '), e.w, e.level.toFixed(3), e.levelKind, e.barsToFail, e.trappedVol.toFixed(2), e.reclaimDelta.toFixed(3), e.phase, +e.goldHolds, +e.goldWithTrade, e.dxyAgainst === null ? '' : +e.dxyAgainst, (100 * e.rsVsGold).toFixed(2), e.oiBuild === null ? '' : +e.oiBuild, e.oiChg === null ? '' : (100 * e.oiChg).toFixed(2), e.entry.toFixed(3), e.stop.toFixed(3), e.riskPct.toFixed(2), ...['R1', 'R2', 'R3'].map((k) => (e[k] === null ? '' : e[k].toFixed(3))), e.up24 === null ? '' : +e.up24].join(','))).join('\n'));
console.log('\nEvents written to results/silver/events.csv');
