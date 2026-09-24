// Picks the highest-probability long out of the "shorts trapped" events (1H candles) and tests it.
// Usage: node best-trade.js                                   development window (from 2026-03-24)
//        node best-trade.js --from 2025-03-24 --to 2026-03-24   validation window (unseen data)
//        add --rule R5 to force a rule instead of selecting one
//
// Candidate rules are fixed in advance (below). Selection criterion, stated before looking:
// highest 1R win rate among rules with >= 60 trades and positive expectancy at both 1R and 2R.
const fs = require('fs');
const path = require('path');
const T = require('./trap-analysis');

const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const FROM_T = Date.parse(`${arg('--from', '2026-03-24')}T00:00:00Z`) / 1000;
const TO_T = arg('--to') ? Date.parse(`${arg('--to')}T00:00:00Z`) / 1000 : Infinity;
const TARGETS = [1, 1.5, 2, 3];
const OUT = path.join(__dirname, '..', 'results', 'best-trade');

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1)); };
const stamp = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');

// daily trend: last completed day's close above its 50-day average
function dailyTrend(sym) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', `${sym}_D.json`)));
  const dates = d.map((x) => new Date(x[0] * 1000).toISOString().slice(0, 10));
  const closes = d.map((x) => x[4]);
  return (date) => {
    let i = dates.findIndex((x) => x >= date) - 1;
    if (i < 0) i = dates.length - 1;
    if (i < 49) return 0;
    return closes[i] > mean(closes.slice(i - 49, i + 1)) ? 1 : -1;
  };
}

function simulate(bars, idx, entry, stop, k) {
  const risk = entry - stop;
  const target = entry + k * risk;
  const costR = (2 * T.COST_PER_SIDE * entry) / risk;
  for (let j = idx + 1; j < bars.length && j <= idx + T.MAX_HOLD; j += 1) {
    const { o, h, l, c } = bars[j];
    if (o <= stop) return (o - entry) / risk - costR;
    if (o >= target) return (o - entry) / risk - costR;
    if (l <= stop) return -1 - costR;
    if (h >= target) return k - costR;
    if (j === idx + T.MAX_HOLD) return (c - entry) / risk - costR;
  }
  return null; // still open at the end of the data
}

// ---------- collect events with features ----------
const events = []; const random = [];
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
for (const sym of T.SYMBOLS) {
  const bars = T.loadSeries(sym, '60');
  const trend = dailyTrend(sym);
  const seen = new Map();
  T.detectEvents(bars, sym, '60').filter((e) => e.type === 'shorts_trapped' && e.t >= FROM_T && e.t < TO_T).forEach((e) => {
    if (!seen.has(e.idx) || e.trappedVol > seen.get(e.idx).trappedVol) seen.set(e.idx, e);
  });
  for (const e of seen.values()) {
    const b = bars[e.idx];
    const bd = bars[e.idx - e.barsToFail]; // breakdown bar
    const entry = b.c;
    const stop = entry - e.stopPrice >= T.MIN_RISK_ATR * b.atr ? e.stopPrice : entry - T.MIN_RISK_ATR * b.atr;
    let cvdTrap = 0;
    for (let k = e.idx - e.barsToFail + 1; k <= e.idx; k += 1) cvdTrap += bars[k].delta || 0;
    const ev = {
      sym, t: e.t, level: e.level, levelKind: e.levelKind, barsToFail: e.barsToFail, trappedVol: e.trappedVol,
      breakdownDelta: e.breakoutDeltaPct, breakdownVolMult: bd.v / bd.avgV, reclaimDelta: e.failDeltaPct, reclaimVolMult: e.failVolMult,
      cvdTrap: cvdTrap / b.avgV, // net buying (+) or selling (-) while price was below the level, in average-volume units
      htf: trend(b.day), hour: new Date(e.t * 1000).getUTCHours(), entry, stop, riskPct: (100 * (entry - stop)) / entry,
    };
    TARGETS.forEach((k) => { ev[`R${k}`] = simulate(bars, e.idx, entry, stop, k); });
    events.push(ev);
  }
  // random long entries in the same window, for the baseline
  const first = bars.findIndex((x) => x.t >= FROM_T); const last = bars.findIndex((x) => x.t >= TO_T);
  const end = last < 0 ? bars.length - 1 : last;
  for (let k = 0; k < seen.size * 3; k += 1) {
    const idx = first + Math.floor(rnd() * (end - first));
    const b = bars[idx];
    if (!b.atr || b.delta === null) continue;
    const entry = b.c; const stop0 = b.l - T.STOP_BUFFER_ATR * b.atr;
    const stop = entry - stop0 >= T.MIN_RISK_ATR * b.atr ? stop0 : entry - T.MIN_RISK_ATR * b.atr;
    const ev = {};
    TARGETS.forEach((kk) => { ev[`R${kk}`] = simulate(bars, idx, entry, stop, kk); });
    random.push(ev);
  }
}

// ---------- candidate rules (fixed list) ----------
const RULES = {
  R0: ['all shorts-trapped events', () => true],
  R1: ['trapped volume >= 1x avg', (e) => e.trappedVol >= 1],
  R2: ['R1 + reclaim took 3-8 bars', (e) => e.trappedVol >= 1 && e.barsToFail >= 3],
  R3: ['R2 + level is prior-day low', (e) => RULES.R2[1](e) && e.levelKind === 'PDL'],
  R4: ['R2 + daily trend up', (e) => RULES.R2[1](e) && e.htf === 1],
  R5: ['R2 + buyers won the reclaim candle', (e) => RULES.R2[1](e) && e.reclaimDelta > 0],
  R6: ['R2 + net buying while below the level', (e) => RULES.R2[1](e) && e.cvdTrap > 0],
  R7: ['R2 + trend up + buyers won reclaim', (e) => RULES.R4[1](e) && e.reclaimDelta > 0],
  R8: ['R1 + daily trend up', (e) => e.trappedVol >= 1 && e.htf === 1],
  R9: ['R1 + net buying while below the level', (e) => e.trappedVol >= 1 && e.cvdTrap > 0],
  R10: ['R1 + trend up + net buying below level', (e) => e.trappedVol >= 1 && e.htf === 1 && e.cvdTrap > 0],
};

const stats = (evs, k) => {
  const v = evs.map((e) => e[`R${k}`]).filter((x) => x !== null);
  if (!v.length) return null;
  return { n: v.length, win: v.filter((x) => x > 0).length / v.length, expR: mean(v), ci: 1.96 * sd(v) / Math.sqrt(v.length) };
};
const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
const line = (name, evs) => {
  const s = TARGETS.map((k) => stats(evs, k));
  return name.padEnd(44) + String(s[0] ? s[0].n : 0).padEnd(5) + s.map((x, i) => (x ? `${(100 * x.win).toFixed(0).padStart(3)}% ${f(x.expR)}±${x.ci.toFixed(2)}` : '   n/a          ').padEnd(18)).join('');
};

const windowName = `${arg('--from', '2026-03-24')}${arg('--to') ? `_to_${arg('--to')}` : '_onwards'}`;
console.log(`\nWindow ${windowName}: ${events.length} shorts-trapped events (1H), ${random.length} random long entries`);
console.log('rule'.padEnd(44) + 'n    ' + TARGETS.map((k) => `${k}R: win expR`.padEnd(18)).join(''));
console.log(line('random long entries', random));
Object.entries(RULES).forEach(([id, [name, fn]]) => console.log(line(`${id} ${name}`, events.filter(fn))));

// selection (development window) or forced rule (validation)
let chosen = arg('--rule');
if (!chosen) {
  const ok = Object.entries(RULES).map(([id, [, fn]]) => ({ id, s1: stats(events.filter(fn), 1), s2: stats(events.filter(fn), 2) }))
    .filter((r) => r.s1 && r.s1.n >= 60 && r.s1.expR > 0 && r.s2 && r.s2.expR > 0)
    .sort((a, b) => b.s1.win - a.s1.win);
  chosen = ok.length ? ok[0].id : null;
  console.log(`\nSelected by criterion (max 1R win rate, n>=60, expR>0 at 1R and 2R): ${chosen ? `${chosen} ${RULES[chosen][0]}` : 'none qualifies'}`);
}
if (chosen) {
  const sel = events.filter(RULES[chosen][1]).sort((a, b) => a.t - b.t);
  fs.mkdirSync(OUT, { recursive: true });
  const cols = ['sym', 'time', 'level', 'levelKind', 'barsToFail', 'trappedVol_x_avg', 'breakdownDelta', 'breakdownVolMult', 'reclaimDelta', 'reclaimVolMult', 'cvdTrap_x_avgV', 'dailyTrend', 'hourUTC', 'entry', 'stop', 'riskPct', ...TARGETS.map((k) => `R_${k}R`)];
  fs.writeFileSync(path.join(OUT, `${chosen}_${windowName}.csv`), [cols.join(',')].concat(sel.map((e) => [e.sym, stamp(e.t), e.level.toFixed(2), e.levelKind, e.barsToFail, e.trappedVol.toFixed(2), e.breakdownDelta.toFixed(3), e.breakdownVolMult.toFixed(2), e.reclaimDelta.toFixed(3), e.reclaimVolMult.toFixed(2), e.cvdTrap.toFixed(2), e.htf, e.hour, e.entry.toFixed(2), e.stop.toFixed(2), e.riskPct.toFixed(2), ...TARGETS.map((k) => (e[`R${k}`] === null ? '' : e[`R${k}`].toFixed(3)))].join(','))).join('\n'));
  // by stock and by month for the chosen rule
  console.log(`\n${chosen} by stock (1R win / 2R expR):`);
  T.SYMBOLS.forEach((s) => { const e = sel.filter((x) => x.sym === s); const a = stats(e, 1); const b = stats(e, 2); if (a) console.log(`  ${s.padEnd(6)} n=${String(a.n).padEnd(4)} ${(100 * a.win).toFixed(0)}%  ${f(b.expR)}R`); });
  console.log(`${chosen} by month (n, 1R win, 2R expR):`);
  const months = [...new Set(sel.map((e) => stamp(e.t).slice(0, 7)))];
  months.forEach((m) => { const e = sel.filter((x) => stamp(x.t).startsWith(m)); const a = stats(e, 1); const b = stats(e, 2); if (a) console.log(`  ${m}  n=${String(a.n).padEnd(4)} ${(100 * a.win).toFixed(0)}%  ${f(b.expR)}R`); });
  console.log(`\nTrades written to results/best-trade/${chosen}_${windowName}.csv`);
}
