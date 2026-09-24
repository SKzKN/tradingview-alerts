// Where do longs / shorts get trapped, and what happens next? Stocks, last 6 months.
// Needs per-candle buy/sell footprints in data/footprints/<SYM>_<TF>.json (fetch-footprints.js).
// Usage: node trap-analysis.js [--from 2026-03-24] [--tf 60,30]
//
// Events (all detected at the close of the bar that completes them, no look-ahead):
//   longs_trapped   first close above a level with buyer delta, then a close back below within MAX_WAIT bars
//   shorts_trapped  mirror at a level below
//   forced_selling  extreme sell-delta candle on >= 2x volume, closing down  (stop-outs / capitulation)
//   forced_buying   mirror (short squeeze candle)
//   cvd_div_low     price sweeps below the last pivot low, but CVD since that pivot is positive (sellers exhausted)
//   cvd_div_high    mirror
// Outcomes: forward move in ATRs at several horizons, signed by the thesis direction, and a simulated
// trade (entry at event close, stop beyond the event extreme, 1R/2R/3R targets, costs) vs. random entries.
const fs = require('fs');
const path = require('path');

const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'IREN', 'NBIS'];
const TIMEFRAMES = arg('--tf', '60,30').split(',');
const FROM_T = Date.parse(`${arg('--from', '2026-03-24')}T00:00:00Z`) / 1000;
const L = 5; // pivot lookback
const MAX_WAIT = 8; // bars a breakout has to fail in, to count as a trap
const MAX_LEVEL_AGE = 200;
const HORIZONS = [1, 2, 4, 8, 13, 26];
const MAX_HOLD = 26;
const COST_PER_SIDE = 0.0005;
const VOL_AVG = 20;
const FLUSH_VOL_MULT = 2; // forced selling/buying needs this much of average volume
const FLUSH_DELTA = 0.3; // and |delta| >= 30% of the candle's volume
const STOP_BUFFER_ATR = 0.1;
const MIN_RISK_ATR = 0.5;
const CONTROL_MULT = 3;
const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, '..', 'results', 'traps-6m');

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1)); };
const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const stamp = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');

function loadSeries(sym, tf) {
  const bars = JSON.parse(fs.readFileSync(path.join(DATA, `${sym}_${tf}.json`)))
    .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v: v || 0 }));
  const fpFile = path.join(DATA, 'footprints', `${sym}_${tf}.json`);
  const fp = fs.existsSync(fpFile) ? JSON.parse(fs.readFileSync(fpFile)) : {};
  let atr = 0; let cvd = 0; const vols = [];
  bars.forEach((b, i) => {
    const rows = fp[b.t];
    if (rows && rows.length >= 5) {
      b.rows = rows;
      b.buy = rows.reduce((s, r) => s + r[2], 0);
      b.sell = rows.reduce((s, r) => s + r[3], 0);
      b.delta = b.buy - b.sell;
      b.deltaPct = b.v ? b.delta / b.v : 0;
    } else { b.delta = null; b.deltaPct = null; }
    cvd += b.delta || 0; b.cvd = cvd; // continuous CVD (bars without footprint add 0)
    if (i > 0) {
      const tr = Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
      atr = i <= 14 ? atr + tr / 14 : (atr * 13 + tr) / 14;
    }
    b.atr = i >= 14 ? atr : null;
    vols.push(b.v); if (vols.length > VOL_AVG) vols.shift();
    b.avgV = vols.length === VOL_AVG ? mean(vols) : null;
    b.day = dateOf(b.t);
  });
  return bars;
}

// volume that traded on `side` beyond `level` inside bars [from..to] (the trapped positions)
function volumeBeyond(bars, from, to, level, dir) {
  let sum = 0;
  for (let k = from; k <= to; k += 1) {
    (bars[k].rows || []).forEach(([lo, hi, bv, sv]) => {
      const mid = (lo + hi) / 2;
      if (dir === 1 ? mid > level : mid < level) sum += dir === 1 ? bv : sv;
    });
  }
  return sum;
}

function detectEvents(bars, sym, tf) {
  const events = [];
  const active = { up: [], down: [] }; // levels waiting for a breakout
  const pending = []; // breakouts waiting to fail or hold
  const pivotLows = []; const pivotHighs = [];
  let prevDay = null; let dayH = -Infinity; let dayL = Infinity; let pdh = null; let pdl = null;

  for (let n = 1; n < bars.length; n += 1) {
    const b = bars[n];
    const ok = b.atr && b.avgV && b.delta !== null && b.t >= FROM_T;

    // prior-day high/low become levels at the first bar of a new day
    if (b.day !== prevDay) {
      if (prevDay !== null) {
        pdh = dayH; pdl = dayL;
        active.up.push({ price: pdh, idx: n - 1, kind: 'PDH' });
        active.down.push({ price: pdl, idx: n - 1, kind: 'PDL' });
      }
      prevDay = b.day; dayH = -Infinity; dayL = Infinity;
    }
    dayH = Math.max(dayH, b.h); dayL = Math.min(dayL, b.l);

    // pivots confirmed at n (pivot bar i = n - L)
    const i = n - L;
    if (i >= L) {
      let isLow = true; let isHigh = true;
      for (let k = i - L; k <= i + L; k += 1) {
        if (k === i) continue;
        if (k < i ? bars[k].l <= bars[i].l : bars[k].l < bars[i].l) isLow = false;
        if (k < i ? bars[k].h >= bars[i].h : bars[k].h > bars[i].h) isHigh = false;
      }
      if (isLow) { active.down.push({ price: bars[i].l, idx: i, kind: 'pivot' }); pivotLows.push({ idx: i, price: bars[i].l, cvd: bars[i].cvd }); }
      if (isHigh) { active.up.push({ price: bars[i].h, idx: i, kind: 'pivot' }); pivotHighs.push({ idx: i, price: bars[i].h, cvd: bars[i].cvd }); }
    }

    // resolve pending breakouts
    for (let k = pending.length - 1; k >= 0; k -= 1) {
      const p = pending[k];
      const failed = p.dir === 1 ? b.c < p.level : b.c > p.level;
      if (failed) {
        pending.splice(k, 1);
        if (!ok) continue;
        const extreme = p.dir === 1 ? Math.max(...bars.slice(p.idx, n + 1).map((x) => x.h)) : Math.min(...bars.slice(p.idx, n + 1).map((x) => x.l));
        const trapped = volumeBeyond(bars, p.idx, n, p.level, p.dir) / b.avgV;
        events.push({
          type: p.dir === 1 ? 'longs_trapped' : 'shorts_trapped', dir: -p.dir, sym, tf, idx: n, t: b.t,
          level: p.level, levelKind: p.kind, barsToFail: n - p.idx, breakoutDeltaPct: p.deltaPct,
          trappedVol: trapped, failDeltaPct: b.deltaPct, failVolMult: b.v / b.avgV,
          forced: (p.dir === 1 ? b.deltaPct < 0 : b.deltaPct > 0) && b.v >= 1.2 * b.avgV,
          stopPrice: p.dir === 1 ? extreme + STOP_BUFFER_ATR * b.atr : extreme - STOP_BUFFER_ATR * b.atr,
        });
      } else if (n - p.idx >= MAX_WAIT) {
        pending.splice(k, 1);
        if (ok) events.push({ type: p.dir === 1 ? 'breakout_up_held' : 'breakout_down_held', dir: p.dir, sym, tf, idx: n, t: b.t, level: p.level, levelKind: p.kind, breakoutDeltaPct: p.deltaPct, stopPrice: p.dir === 1 ? p.level - STOP_BUFFER_ATR * b.atr : p.level + STOP_BUFFER_ATR * b.atr });
      }
    }

    // new breakouts: first close beyond an active level (prev close was not beyond)
    for (const [side, dir] of [['up', 1], ['down', -1]]) {
      const list = active[side];
      for (let k = list.length - 1; k >= 0; k -= 1) {
        const lv = list[k];
        const beyond = dir === 1 ? b.c > lv.price : b.c < lv.price;
        const prevBeyond = dir === 1 ? bars[n - 1].c > lv.price : bars[n - 1].c < lv.price;
        if (n - lv.idx > MAX_LEVEL_AGE) { list.splice(k, 1); continue; }
        if (beyond && !prevBeyond && n > lv.idx + (lv.kind === 'pivot' ? L : 0)) {
          list.splice(k, 1);
          if (b.delta !== null && (dir === 1 ? b.deltaPct > 0 : b.deltaPct < 0)) pending.push({ dir, idx: n, level: lv.price, kind: lv.kind, deltaPct: b.deltaPct });
        }
      }
    }

    if (!ok) continue;

    // forced selling / buying flush candles
    if (b.v >= FLUSH_VOL_MULT * b.avgV && b.deltaPct <= -FLUSH_DELTA && b.c < b.o) {
      events.push({ type: 'forced_selling', dir: 1, sym, tf, idx: n, t: b.t, deltaPct: b.deltaPct, volMult: b.v / b.avgV, closePos: (b.c - b.l) / (b.h - b.l || 1), stopPrice: b.l - STOP_BUFFER_ATR * b.atr });
    }
    if (b.v >= FLUSH_VOL_MULT * b.avgV && b.deltaPct >= FLUSH_DELTA && b.c > b.o) {
      events.push({ type: 'forced_buying', dir: -1, sym, tf, idx: n, t: b.t, deltaPct: b.deltaPct, volMult: b.v / b.avgV, closePos: (b.c - b.l) / (b.h - b.l || 1), stopPrice: b.h + STOP_BUFFER_ATR * b.atr });
    }

    // CVD divergence on a sweep of the last pivot (only the first bar that sweeps it)
    const pl = pivotLows[pivotLows.length - 1];
    if (pl && b.l < pl.price && bars[n - 1].l >= pl.price && n - pl.idx <= MAX_LEVEL_AGE) {
      const cvdChange = b.cvd - pl.cvd;
      events.push({ type: cvdChange > 0 ? 'cvd_div_low' : 'sweep_low_confirmed', dir: 1, sym, tf, idx: n, t: b.t, level: pl.price, cvdChangeAvgV: cvdChange / b.avgV, reclaimed: b.c > pl.price, stopPrice: b.l - STOP_BUFFER_ATR * b.atr });
    }
    const ph = pivotHighs[pivotHighs.length - 1];
    if (ph && b.h > ph.price && bars[n - 1].h <= ph.price && n - ph.idx <= MAX_LEVEL_AGE) {
      const cvdChange = b.cvd - ph.cvd;
      events.push({ type: cvdChange < 0 ? 'cvd_div_high' : 'sweep_high_confirmed', dir: -1, sym, tf, idx: n, t: b.t, level: ph.price, cvdChangeAvgV: cvdChange / b.avgV, reclaimed: b.c < ph.price, stopPrice: b.h + STOP_BUFFER_ATR * b.atr });
    }
  }
  return events;
}

// forward moves (in ATRs, signed by dir) and a simulated trade
function outcomes(bars, ev) {
  const b = bars[ev.idx];
  ev.fwd = {};
  HORIZONS.forEach((h) => { ev.fwd[h] = ev.idx + h < bars.length ? (ev.dir * (bars[ev.idx + h].c - b.c)) / b.atr : null; });
  const entry = b.c;
  // stop at least MIN_RISK_ATR away, otherwise a candle closing at its extreme gives a stop of a few cents
  const stop = Math.abs(entry - ev.stopPrice) >= MIN_RISK_ATR * b.atr ? ev.stopPrice : entry - ev.dir * MIN_RISK_ATR * b.atr;
  ev.stopPrice = stop;
  const risk = Math.abs(entry - stop);
  ev.riskPct = (100 * risk) / entry;
  const costR = (2 * COST_PER_SIDE * entry) / risk;
  ev.trade = {};
  for (const k of [1, 2, 3]) {
    const target = entry + ev.dir * k * risk;
    let res = null;
    for (let j = ev.idx + 1; j < bars.length && j <= ev.idx + MAX_HOLD; j += 1) {
      const { o, h, l } = bars[j];
      const hitStop = ev.dir === 1 ? (o <= stop || l <= stop) : (o >= stop || h >= stop);
      const hitTgt = ev.dir === 1 ? (o >= target || h >= target) : (o <= target || l <= target);
      if (hitStop && (ev.dir === 1 ? o <= stop : o >= stop)) { res = (ev.dir * (o - entry)) / risk; break; }
      if (hitTgt && (ev.dir === 1 ? o >= target : o <= target)) { res = (ev.dir * (o - entry)) / risk; break; }
      if (hitStop) { res = -1; break; } // stop first when both are touched
      if (hitTgt) { res = k; break; }
      if (j === ev.idx + MAX_HOLD) res = (ev.dir * (bars[j].c - entry)) / risk;
    }
    ev.trade[k] = res === null ? null : res - costR;
  }
}

function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

module.exports = { loadSeries, detectEvents, outcomes, volumeBeyond, HORIZONS, MAX_HOLD, COST_PER_SIDE, STOP_BUFFER_ATR, MIN_RISK_ATR, SYMBOLS };
if (require.main !== module) return;

// ---------- run ----------
const events = []; const control = []; const coverage = [];
for (const sym of SYMBOLS) {
  for (const tf of TIMEFRAMES) {
    const bars = loadSeries(sym, tf);
    const inWin = bars.filter((b) => b.t >= FROM_T);
    coverage.push({ sym, tf, bars: inWin.length, withFootprint: inWin.filter((b) => b.delta !== null).length });
    // one event per candle and type (a candle can fail a pivot and a prior-day level at almost the same price)
    const seen = new Map();
    detectEvents(bars, sym, tf).forEach((ev) => {
      const key = `${ev.type}|${ev.idx}`;
      if (!seen.has(key) || (ev.trappedVol || 0) > (seen.get(key).trappedVol || 0)) seen.set(key, ev);
    });
    const evs = [...seen.values()];
    evs.forEach((ev) => outcomes(bars, ev));
    events.push(...evs);
    const rnd = mulberry32(SYMBOLS.indexOf(sym) * 7 + TIMEFRAMES.indexOf(tf) + 1);
    const first = bars.findIndex((b) => b.t >= FROM_T);
    for (let k = 0; k < evs.length * CONTROL_MULT; k += 1) {
      const idx = first + Math.floor(rnd() * (bars.length - first - 1));
      const b = bars[idx];
      if (!b.atr || b.delta === null) continue;
      const dir = rnd() < 0.5 ? 1 : -1;
      const ev = { type: 'random', dir, sym, tf, idx, t: b.t, stopPrice: dir === 1 ? b.l - STOP_BUFFER_ATR * b.atr : b.h + STOP_BUFFER_ATR * b.atr };
      outcomes(bars, ev); control.push(ev);
    }
  }
}

// ---------- summaries ----------
const summarize = (evs) => {
  const row = { n: evs.length };
  HORIZONS.forEach((h) => { const v = evs.map((e) => e.fwd[h]).filter((x) => x !== null); row[`fwd${h}`] = v.length ? { mean: mean(v), median: median(v), pos: v.filter((x) => x > 0).length / v.length, ci: 1.96 * sd(v) / Math.sqrt(v.length) } : null; });
  [1, 2, 3].forEach((k) => { const v = evs.map((e) => e.trade[k]).filter((x) => x !== null); row[`R${k}`] = v.length ? { n: v.length, expR: mean(v), win: v.filter((x) => x > 0).length / v.length, ci: 1.96 * sd(v) / Math.sqrt(v.length) } : null; });
  return row;
};
const groups = {};
const add = (name, evs) => { if (evs.length) groups[name] = summarize(evs); };
const types = [...new Set(events.map((e) => e.type))];
for (const tf of ['all', ...TIMEFRAMES]) {
  const sel = (evs) => (tf === 'all' ? evs : evs.filter((e) => e.tf === tf));
  types.forEach((ty) => add(`${tf} | ${ty}`, sel(events.filter((e) => e.type === ty))));
  add(`${tf} | random long`, sel(control.filter((e) => e.dir === 1)));
  add(`${tf} | random short`, sel(control.filter((e) => e.dir === -1)));
  for (const ty of ['longs_trapped', 'shorts_trapped']) {
    const t = sel(events.filter((e) => e.type === ty));
    add(`${tf} | ${ty} + forced flush on fail bar`, t.filter((e) => e.forced));
    add(`${tf} | ${ty}, no flush`, t.filter((e) => !e.forced));
    add(`${tf} | ${ty}, trapped vol >= 1x avg`, t.filter((e) => e.trappedVol >= 1));
    add(`${tf} | ${ty}, trapped vol < 1x avg`, t.filter((e) => e.trappedVol < 1));
    add(`${tf} | ${ty}, failed within 2 bars`, t.filter((e) => e.barsToFail <= 2));
    add(`${tf} | ${ty}, failed in 3-8 bars`, t.filter((e) => e.barsToFail > 2));
    add(`${tf} | ${ty}, level = prior day`, t.filter((e) => e.levelKind !== 'pivot'));
    add(`${tf} | ${ty}, level = pivot`, t.filter((e) => e.levelKind === 'pivot'));
  }
  if (tf !== 'all') {
    const mid = FROM_T + (Math.max(...events.map((e) => e.t)) - FROM_T) / 2;
    for (const ty of ['longs_trapped', 'shorts_trapped']) {
      const t = sel(events.filter((e) => e.type === ty));
      add(`${tf} | ${ty}, first 3 months`, t.filter((e) => e.t < mid));
      add(`${tf} | ${ty}, last 3 months`, t.filter((e) => e.t >= mid));
      SYMBOLS.forEach((s) => add(`${tf} | ${ty}, ${s}`, t.filter((e) => e.sym === s)));
    }
  }
  for (const ty of ['forced_selling', 'forced_buying']) {
    const t = sel(events.filter((e) => e.type === ty));
    add(`${tf} | ${ty}, close off extreme (>=40%)`, t.filter((e) => (ty === 'forced_selling' ? e.closePos >= 0.4 : e.closePos <= 0.6)));
    add(`${tf} | ${ty}, close at extreme`, t.filter((e) => (ty === 'forced_selling' ? e.closePos < 0.4 : e.closePos > 0.6)));
  }
  for (const ty of ['cvd_div_low', 'cvd_div_high']) {
    const t = sel(events.filter((e) => e.type === ty));
    add(`${tf} | ${ty} + reclaimed (SFP)`, t.filter((e) => e.reclaimed));
    add(`${tf} | ${ty}, not reclaimed`, t.filter((e) => !e.reclaimed));
  }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ coverage, groups }, null, 1));
const cols = ['type', 'sym', 'tf', 'time', 'dir', 'level', 'levelKind', 'barsToFail', 'breakoutDeltaPct', 'trappedVol_x_avg', 'failDeltaPct', 'failVolMult', 'forced', 'deltaPct', 'volMult', 'closePos', 'cvdChange_x_avgV', 'reclaimed', 'stopPct', ...HORIZONS.map((h) => `fwd${h}_ATR`), 'R_1R', 'R_2R', 'R_3R'];
const fmt = (x) => (x === undefined || x === null ? '' : (typeof x === 'number' ? (Number.isInteger(x) ? x : x.toFixed(3)) : x));
const csv = [cols.join(',')].concat(events.sort((a, b) => a.t - b.t).map((e) => [
  e.type, e.sym, e.tf, stamp(e.t), e.dir === 1 ? 'long' : 'short', fmt(e.level), e.levelKind, e.barsToFail, fmt(e.breakoutDeltaPct), fmt(e.trappedVol), fmt(e.failDeltaPct), fmt(e.failVolMult),
  e.forced === undefined ? '' : Number(e.forced), fmt(e.deltaPct), fmt(e.volMult), fmt(e.closePos), fmt(e.cvdChangeAvgV), e.reclaimed === undefined ? '' : Number(e.reclaimed), fmt(e.riskPct),
  ...HORIZONS.map((h) => fmt(e.fwd[h])), fmt(e.trade[1]), fmt(e.trade[2]), fmt(e.trade[3]),
].join(',')));
fs.writeFileSync(path.join(OUT, 'events.csv'), csv.join('\n'));

// ---------- print ----------
const f = (x, d = 2) => (x === null || x === undefined ? '   n/a' : ((x >= 0 ? '+' : '') + x.toFixed(d)).padStart(6));
console.log('Coverage (bars in window / with footprint):', coverage.map((c) => `${c.sym} ${c.tf}: ${c.withFootprint}/${c.bars}`).join(', '));
for (const tf of ['all', ...TIMEFRAMES]) {
  console.log(`\n==================== ${tf === 'all' ? 'BOTH TIMEFRAMES' : `${tf}-minute candles`} ====================`);
  console.log('group'.padEnd(52) + 'n     fwd1   fwd4   fwd8  fwd26  (mean ATR, signed)  %pos8   |  1R expR  win   |  2R expR  win   |  3R expR  win');
  Object.entries(groups).filter(([k]) => k.startsWith(`${tf} |`)).forEach(([k, g]) => {
    const line = k.slice(tf.length + 3).padEnd(52) + String(g.n).padEnd(5)
      + [1, 4, 8, 26].map((h) => f(g[`fwd${h}`]?.mean)).join(' ') + '                      ' + (g.fwd8 ? (100 * g.fwd8.pos).toFixed(0).padStart(3) + '%' : ' n/a')
      + [1, 2, 3].map((r) => `   |  ${f(g[`R${r}`]?.expR)}  ${g[`R${r}`] ? (100 * g[`R${r}`].win).toFixed(0).padStart(3) + '%' : ' n/a'}`).join('');
    console.log(line);
  });
}
