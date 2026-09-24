// Which context, known at entry, predicts an actual move up after a "shorts trapped" reclaim?
// Six pre-registered features, tested on all 1H shorts-trapped events of the 9 stocks, reported
// separately for the unseen year (Mar 2025 - Mar 2026) and the development window (Mar - Sep 2026).
// Usage: node move-up-test.js --from 2025-03-24      (needs QQQ_60 candles + footprints)
const fs = require('fs');
const path = require('path');
const T = require('./trap-analysis');

const DEV_T = Date.parse('2026-03-24T00:00:00Z') / 1000;
const DATA = path.join(__dirname, 'data');
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);

function simulate(bars, idx, entry, stop, k) {
  const risk = entry - stop; const target = entry + k * risk; const costR = (2 * T.COST_PER_SIDE * entry) / risk;
  for (let j = idx + 1; j < bars.length && j <= idx + T.MAX_HOLD; j += 1) {
    const { o, h, l, c } = bars[j];
    if (o <= stop) return (o - entry) / risk - costR;
    if (o >= target) return (o - entry) / risk - costR;
    if (l <= stop) return -1 - costR;
    if (h >= target) return k - costR;
    if (j === idx + T.MAX_HOLD) return (c - entry) / risk - costR;
  }
  return null;
}

// ---------- QQQ context ----------
const qqq = T.loadSeries('QQQ', '60');
const qIdx = new Map(qqq.map((b, i) => [b.t, i]));
let prevDay = null; let dayL = Infinity; let pdl = null;
qqq.forEach((b) => { if (b.day !== prevDay) { if (prevDay !== null) pdl = dayL; prevDay = b.day; dayL = Infinity; } dayL = Math.min(dayL, b.l); b.pdl = pdl; });

// ---------- daily levels per stock ----------
function dailyLevels(sym) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, `${sym}_D.json`)));
  const dates = d.map((x) => new Date(x[0] * 1000).toISOString().slice(0, 10));
  const weekKey = (ds) => { const dt = new Date(`${ds}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10); };
  return (date) => { // levels known before `date`
    let i = dates.findIndex((x) => x >= date) - 1; if (i < 0) i = dates.length - 1;
    const out = [];
    if (i >= 49) out.push(mean(d.slice(i - 49, i + 1).map((x) => x[4]))); // 50-day SMA
    const wk = weekKey(date);
    const prevWeeks = [...new Set(dates.slice(Math.max(0, i - 15), i + 1).map(weekKey))].filter((w) => w < wk).sort();
    if (prevWeeks.length) { // prior week's low
      const pwk = prevWeeks[prevWeeks.length - 1];
      out.push(Math.min(...d.filter((x, k) => weekKey(dates[k]) === pwk).map((x) => x[3])));
    }
    for (let k = i - 5; k >= Math.max(5, i - 60); k -= 1) { // daily pivot lows (5 days each side) in the last 60 days
      let ok = true; for (let m = k - 5; m <= k + 5; m += 1) if (m !== k && d[m][3] <= d[k][3]) { ok = false; break; }
      if (ok) out.push(d[k][3]);
    }
    return out;
  };
}

// ---------- events ----------
const events = [];
for (const sym of T.SYMBOLS) {
  const bars = T.loadSeries(sym, '60');
  const levels = dailyLevels(sym);
  const seen = new Map();
  T.detectEvents(bars, sym, '60').filter((e) => e.type === 'shorts_trapped').forEach((e) => { if (!seen.has(e.idx) || e.trappedVol > seen.get(e.idx).trappedVol) seen.set(e.idx, e); });
  for (const e of seen.values()) {
    const b = bars[e.idx]; const bd = bars[e.idx - e.barsToFail];
    const entry = b.c; const stop = entry - e.stopPrice >= T.MIN_RISK_ATR * b.atr ? e.stopPrice : entry - T.MIN_RISK_ATR * b.atr;
    const qi = qIdx.get(b.t); const qd = qIdx.get(bd.t);
    if (qi === undefined || qd === undefined || qqq[qi].delta === null || !qqq[qi].pdl) continue;
    const q = qqq[qi];
    const next = bars[e.idx + 1];
    const ev = {
      sym, t: b.t, w: b.t >= DEV_T ? 'dev' : 'oos', r2rule: e.trappedVol >= 1 && e.barsToFail >= 3,
      R1: simulate(bars, e.idx, entry, stop, 1), R2: simulate(bars, e.idx, entry, stop, 2),
      up26: e.idx + 26 < bars.length ? bars[e.idx + 26].c > b.c : null,
      // F1 index context
      qqqAbovePDL: q.c > q.pdl, qqqDelta: q.deltaPct > 0, qqqTrapUp: q.c > qqq[qd].c,
      // F2 relative strength during the trap
      rs: (b.c / bd.c - 1) - (q.c / qqq[qd].c - 1),
      // F4 follow-through (next bar holds above the level with buyers)
      confirmed: next ? next.c > e.level && next.delta > 0 : null,
      R1c: next ? simulate(bars, e.idx + 1, next.c, Math.min(stop, next.l - T.STOP_BUFFER_ATR * b.atr), 1) : null,
      R2c: next ? simulate(bars, e.idx + 1, next.c, Math.min(stop, next.l - T.STOP_BUFFER_ATR * b.atr), 2) : null,
      // F5 higher-timeframe location
      htfLevel: levels(b.day).some((x) => Math.abs(x - e.level) <= b.atr),
      // F6 time of day
      hour: new Date(b.t * 1000).getUTCHours(),
    };
    events.push(ev);
  }
}
// F3 how many of the 9 trapped in the same hour (+-1 bar)
const byT = new Map(); events.forEach((e) => byT.set(e.t, (byT.get(e.t) || 0) + 1));
events.forEach((e) => { e.count = (byT.get(e.t) || 0) + (byT.get(e.t - 3600) || 0) + (byT.get(e.t + 3600) || 0); });

// ---------- report ----------
const st = (evs, k1 = 'R1', k2 = 'R2') => {
  const a = evs.map((e) => e[k1]).filter((x) => x !== null); const b2 = evs.map((e) => e[k2]).filter((x) => x !== null); const u = evs.map((e) => e.up26).filter((x) => x !== null);
  if (!a.length) return 'n=0';
  return `n=${String(a.length).padEnd(4)} 1R win ${(100 * a.filter((x) => x > 0).length / a.length).toFixed(0).padStart(3)}%  1R ${f(mean(a)).padStart(5)}  2R ${f(mean(b2)).padStart(5)}  up-in-26 ${(100 * u.filter(Boolean).length / u.length).toFixed(0).padStart(3)}%`;
};
const row = (label, fn, k1, k2) => {
  console.log(`  ${label.padEnd(40)} unseen: ${st(events.filter((e) => e.w === 'oos' && fn(e)), k1, k2)}`);
  console.log(`  ${''.padEnd(40)} dev:    ${st(events.filter((e) => e.w === 'dev' && fn(e)), k1, k2)}`);
};
console.log(`\n${events.length} shorts-trapped events with QQQ context (${events.filter((e) => e.w === 'oos').length} unseen year, ${events.filter((e) => e.w === 'dev').length} dev window)\n`);
console.log('BASELINES'); row('all events', () => true); row('rule R2 (trapped vol>=1x, 3-8 bars)', (e) => e.r2rule);
console.log('\nF1 INDEX CONTEXT (QQQ at the reclaim hour)');
row('QQQ above its prior-day low', (e) => e.qqqAbovePDL); row('QQQ below its prior-day low', (e) => !e.qqqAbovePDL);
row('QQQ buyer delta this hour', (e) => e.qqqDelta); row('QQQ seller delta this hour', (e) => !e.qqqDelta);
row('QQQ rose during the trap', (e) => e.qqqTrapUp); row('QQQ fell during the trap', (e) => !e.qqqTrapUp);
console.log('\nF2 RELATIVE STRENGTH during the trap (stock vs QQQ)');
row('stock outperformed QQQ', (e) => e.rs > 0); row('stock underperformed QQQ', (e) => e.rs <= 0);
row('stock reclaimed while QQQ fell (RS>0 & QQQ down)', (e) => e.rs > 0 && !e.qqqTrapUp);
console.log('\nF3 HOW MANY OF THE 9 TRAPPED AT ONCE (same hour +-1)');
row('alone (1)', (e) => e.count === 1); row('2', (e) => e.count === 2); row('3 or more', (e) => e.count >= 3);
console.log('\nF4 FOLLOW-THROUGH: enter at the NEXT candle close instead (stop under both lows)');
row('next candle holds level with buyers -> enter', (e) => e.confirmed === true, 'R1c', 'R2c');
row('next candle fails/sellers -> would enter', (e) => e.confirmed === false, 'R1c', 'R2c');
row('(for reference: original entry, confirmed subset)', (e) => e.confirmed === true);
console.log('\nF5 HIGHER-TIMEFRAME LOCATION');
row('level within 1 ATR of a daily level', (e) => e.htfLevel); row('no daily level nearby', (e) => !e.htfLevel);
console.log('\nF6 TIME OF DAY (UTC hour of the reclaim candle; 13 = first hour, 19 = last)');
row('first hour (13)', (e) => e.hour === 13); row('mid-day (14-17)', (e) => e.hour >= 14 && e.hour <= 17); row('last two hours (18-19)', (e) => e.hour >= 18);
console.log('\nCOMBINATIONS (pre-stated): F1 + F2 + F3');
row('QQQ above PDL & stock outperformed', (e) => e.qqqAbovePDL && e.rs > 0);
row('QQQ above PDL & 3+ trapped at once', (e) => e.qqqAbovePDL && e.count >= 3);
row('QQQ above PDL & confirmed next candle', (e) => e.qqqAbovePDL && e.confirmed === true, 'R1c', 'R2c');
row('QQQ below PDL & stock underperformed', (e) => !e.qqqAbovePDL && e.rs <= 0);

fs.mkdirSync(path.join(__dirname, '..', 'results', 'move-up'), { recursive: true });
const cols = ['sym', 'time', 'window', 'r2rule', 'qqqAbovePDL', 'qqqDelta', 'qqqTrapUp', 'rs', 'count', 'confirmed', 'htfLevel', 'hourUTC', 'R_1R', 'R_2R', 'R_1R_nextCandle', 'R_2R_nextCandle', 'upIn26'];
fs.writeFileSync(path.join(__dirname, '..', 'results', 'move-up', 'events.csv'), [cols.join(',')].concat(events.sort((a, b) => a.t - b.t).map((e) => [e.sym, new Date(e.t * 1000).toISOString().slice(0, 16).replace('T', ' '), e.w, +e.r2rule, +e.qqqAbovePDL, +e.qqqDelta, +e.qqqTrapUp, (100 * e.rs).toFixed(2), e.count, e.confirmed === null ? '' : +e.confirmed, +e.htfLevel, e.hour, ...['R1', 'R2', 'R1c', 'R2c'].map((k) => (e[k] === null ? '' : e[k].toFixed(3))), e.up26 === null ? '' : +e.up26].join(','))).join('\n'));
console.log('\nEvents written to results/move-up/events.csv');
