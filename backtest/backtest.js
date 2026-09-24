// Mechanical backtest of the SFP / volume-profile strategy (protocol section 7).
// Usage: node backtest.js                     all history  -> ../results/backtest/
//        node backtest.js --from 2024-09-24   only trades from that date (earlier bars still used as warm-up)
//                                             -> ../results/backtest-from-2024-09-24/
//        --to 2024-09-24                      only trades before that date
//
// Trigger (setup A): candle wicks through an unswept pivot low (high) and closes back above (below) it.
// Entry at the SFP candle's close. Stop just beyond the SFP wick. Every signal is evaluated
// independently (no position-overlap rule), which measures the trigger's edge, not an account.
const fs = require('fs');
const path = require('path');

// ---------- Parameters ----------
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const SYMBOLS = arg('--symbols') ? arg('--symbols').split(',') : ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'IREN', 'NBIS'];
const TIMEFRAMES = arg('--tf') ? arg('--tf').split(',') : ['60', '240'];
const PIVOT_LOOKBACKS = [5, 10]; // bars each side of a swing point
const RANGE_BARS = 120; // rolling "fixed range" for the volume profile (POC/VAH/VAL)
const CONTEXT_BARS = 250; // lookback for impulse fib, AVWAP anchor, S/R flips
const MAX_LEVEL_AGE = 300; // an unswept pivot stays tradeable this many bars
const MAX_HOLD = 150; // time stop, in bars
const STOP_BUFFER_ATR = 0.1; // stop sits this far beyond the wick
const TOL_ATR = 0.5; // "near a level" tolerance for confluence
const COST_PER_SIDE = arg('--cost') ? Number(arg('--cost')) : 0.0005; // commission + slippage per side
const OI_BUILD_BARS = 6; // open-interest build-up is measured over this many bars before the sweep
const CONTROL_MULT = 3; // random-entry control samples per real signal
const DATA = path.join(__dirname, 'data');
const FROM = arg('--from');
if (FROM && !/^\d{4}-\d{2}-\d{2}$/.test(FROM)) throw new Error('--from needs a date like 2024-09-24');
const FROM_T = FROM ? Date.parse(`${FROM}T00:00:00Z`) / 1000 : 0;
const TO = arg('--to');
if (TO && !/^\d{4}-\d{2}-\d{2}$/.test(TO)) throw new Error('--to needs a date like 2024-09-24');
const TO_T = TO ? Date.parse(`${TO}T00:00:00Z`) / 1000 : Infinity;
const OUT = path.join(__dirname, '..', 'results', ['backtest', arg('--symbols') && SYMBOLS.join('+'), FROM && `from-${FROM}`, TO && `to-${TO}`].filter(Boolean).join('-'));

// ---------- Helpers ----------
const load = (sym, tf) => JSON.parse(fs.readFileSync(path.join(DATA, `${sym}_${tf}.json`)))
  .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v: v || 0 }));
const dateOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1)); };

function atrSeries(b, n = 14) {
  const out = new Array(b.length).fill(null);
  let atr = 0;
  for (let i = 1; i < b.length; i += 1) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    atr = i <= n ? atr + tr / n : (atr * (n - 1) + tr) / n;
    if (i >= n) out[i] = atr;
  }
  return out;
}

// Volume profile over bars[a..z] inclusive: POC, 70% value area, range extremes
function profile(b, a, z, nb = 40) {
  let lo = Infinity; let hi = -Infinity;
  for (let i = a; i <= z; i += 1) { lo = Math.min(lo, b[i].l); hi = Math.max(hi, b[i].h); }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / nb;
  const vol = new Array(nb).fill(0);
  for (let i = a; i <= z; i += 1) {
    const bl = Math.min(nb - 1, Math.floor((b[i].l - lo) / step));
    const bh = Math.min(nb - 1, Math.floor((b[i].h - lo) / step));
    const share = b[i].v / (bh - bl + 1);
    for (let k = bl; k <= bh; k += 1) vol[k] += share;
  }
  const total = vol.reduce((s, x) => s + x, 0);
  let poc = 0;
  vol.forEach((x, k) => { if (x > vol[poc]) poc = k; });
  let lk = poc; let hk = poc; let acc = vol[poc];
  while (acc < 0.7 * total && (lk > 0 || hk < nb - 1)) {
    const up = hk < nb - 1 ? vol[hk + 1] : -1;
    const dn = lk > 0 ? vol[lk - 1] : -1;
    if (up >= dn) { hk += 1; acc += up; } else { lk -= 1; acc += dn; }
  }
  return { poc: lo + (poc + 0.5) * step, val: lo + lk * step, vah: lo + (hk + 1) * step, rangeLow: lo, rangeHigh: hi };
}

// ---------- Daily context: HTF trend and weekly/monthly levels ----------
function buildDaily(sym) {
  const d = load(sym, 'D');
  const closes = d.map((x) => x.c);
  const sma50 = closes.map((_, i) => (i < 49 ? null : mean(closes.slice(i - 49, i + 1))));
  const dates = d.map((x) => dateOf(x.t));
  const weekKey = (ds) => { const dt = new Date(`${ds}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10); };
  const agg = (keyFn) => {
    const m = new Map();
    d.forEach((x, i) => {
      const k = keyFn(dates[i]);
      const g = m.get(k);
      if (!g) m.set(k, { k, h: x.h, l: x.l, c: x.c });
      else { g.h = Math.max(g.h, x.h); g.l = Math.min(g.l, x.l); g.c = x.c; }
    });
    return [...m.values()];
  };
  const weeks = agg(weekKey);
  const months = agg((ds) => ds.slice(0, 7));
  const lastBefore = (arr, key) => { // last element with arr[i].k (or date) < key
    let lo = 0; let hi = arr.length - 1; let ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] < key) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };
  const weekKeys = weeks.map((w) => w.k);
  const monthKeys = months.map((m) => m.k);
  return {
    // trend of the last completed day before `date`: +1 above 50D SMA, -1 below
    trend(date) {
      const i = lastBefore(dates, date);
      if (i < 0 || sma50[i] === null) return 0;
      return closes[i] > sma50[i] ? 1 : -1;
    },
    // previous week's and month's high / low / close
    levels(date) {
      const out = [];
      const w = lastBefore(weekKeys, weekKey(date));
      const m = lastBefore(monthKeys, date.slice(0, 7));
      if (w >= 0) out.push(weeks[w].h, weeks[w].l, weeks[w].c);
      if (m >= 0) out.push(months[m].h, months[m].l, months[m].c);
      return out;
    },
  };
}

// ---------- Naked daily POCs from intraday bars ----------
function buildNakedPocs(b) {
  const days = [];
  let start = 0;
  for (let i = 1; i <= b.length; i += 1) {
    if (i === b.length || dateOf(b[i].t) !== dateOf(b[start].t)) { days.push([start, i - 1]); start = i; }
  }
  return days.map(([s, e]) => {
    const p = profile(b, s, e, 20);
    if (!p) return null;
    let filledAt = Infinity;
    for (let j = e + 1; j < b.length; j += 1) if (b[j].l <= p.poc && p.poc <= b[j].h) { filledAt = j; break; }
    return { end: e, endT: b[e].t, poc: p.poc, filledAt };
  }).filter(Boolean);
}

// ---------- Signals ----------
function findSignals(b, L) {
  const signals = [];
  const lows = []; const highs = []; // active (unswept) pivots
  const allPivotHighs = []; const allPivotLows = [];
  for (let t = 2 * L; t < b.length; t += 1) {
    const i = t - L; // pivot candidate confirmed at bar t
    let isLow = true; let isHigh = true;
    for (let k = i - L; k <= i + L; k += 1) {
      if (k === i) continue;
      if (k < i ? b[k].l <= b[i].l : b[k].l < b[i].l) isLow = false;
      if (k < i ? b[k].h >= b[i].h : b[k].h > b[i].h) isHigh = false;
    }
    if (isLow) { lows.push({ idx: i, price: b[i].l }); allPivotLows.push({ idx: i, known: t, price: b[i].l }); }
    if (isHigh) { highs.push({ idx: i, price: b[i].h }); allPivotHighs.push({ idx: i, known: t, price: b[i].h }); }
    if (t + 1 >= b.length) break;

    const n = t + 1; // check the next bar for a sweep
    const bar = b[n];
    // long SFP: lowest swept pivot low that the bar closed back above
    const sweptLows = lows.filter((p) => bar.l < p.price);
    const longLvl = sweptLows.filter((p) => bar.c > p.price).sort((x, y) => x.price - y.price)[0];
    // short SFP: highest swept pivot high that the bar closed back below
    const sweptHighs = highs.filter((p) => bar.h > p.price);
    const shortLvl = sweptHighs.filter((p) => bar.c < p.price).sort((x, y) => y.price - x.price)[0];
    if (longLvl) signals.push({ idx: n, dir: 1, level: longLvl.price, pivotIdx: longLvl.idx });
    if (shortLvl) signals.push({ idx: n, dir: -1, level: shortLvl.price, pivotIdx: shortLvl.idx });
    // swept or stale levels are consumed
    for (const arr of [lows, highs]) {
      for (let k = arr.length - 1; k >= 0; k -= 1) {
        const p = arr[k];
        if ((arr === lows ? bar.l < p.price : bar.h > p.price) || n - p.idx > MAX_LEVEL_AGE) arr.splice(k, 1);
      }
    }
  }
  return { signals, allPivotHighs, allPivotLows };
}

// ---------- Context for one entry (used by real signals and the random control) ----------
function context(b, atr, ctx, idx, dir, level) {
  const { daily, naked, piv, prefTPV, prefV, oi } = ctx;
  const a = atr[idx];
  const tol = TOL_ATR * a;
  const prof = profile(b, idx - RANGE_BARS + 1, idx);
  const date = dateOf(b[idx].t);
  const from = Math.max(0, idx - CONTEXT_BARS);

  // (c1) profile: level near VAL/VAH (own side) or POC
  const edge = dir === 1 ? prof.val : prof.vah;
  const c1 = Math.abs(level - edge) <= tol || Math.abs(level - prof.poc) <= tol;
  // (c2) naked daily POC from the last 90 days, still unfilled before this bar
  const c2 = naked.some((d) => d.end < idx && b[idx].t - d.endT <= 90 * 86400 && d.filledAt >= idx && Math.abs(d.poc - level) <= tol);
  // (c3) CC pocket 0.65-0.666 or 0.72 retracement of the impulse
  let c3 = false;
  let ext = from; // impulse origin: lowest low (long) / highest high (short)
  for (let k = from; k < idx; k += 1) if (dir === 1 ? b[k].l < b[ext].l : b[k].h > b[ext].h) ext = k;
  let far = null; // impulse end: highest high (long) / lowest low (short) after origin
  for (let k = ext + 1; k < idx; k += 1) if (far === null || (dir === 1 ? b[k].h > far : b[k].l < far)) far = dir === 1 ? b[k].h : b[k].l;
  if (far !== null) {
    const A = dir === 1 ? b[ext].l : b[ext].h;
    const fib = (r) => far - r * (far - A);
    const [z1, z2] = [fib(0.65), fib(0.666)].sort((x, y) => x - y);
    c3 = (level >= z1 - tol && level <= z2 + tol) || Math.abs(level - fib(0.72)) <= tol;
  }
  // (c4) AVWAP anchored at the impulse origin
  const vv = prefV[idx] - prefV[ext];
  const avwap = vv > 0 ? (prefTPV[idx] - prefTPV[ext]) / vv : null;
  const c4 = avwap !== null && Math.abs(level - avwap) <= tol;
  // (c5) HTF level: previous week / month high, low or close
  const c5 = daily.levels(date).some((x) => Math.abs(x - level) <= tol);
  // (c6) S/R flip: an opposite-side pivot at the same price
  const opp = dir === 1 ? piv.allPivotHighs : piv.allPivotLows;
  const c6 = opp.some((p) => p.known < idx && p.idx >= from && Math.abs(p.price - level) <= tol);

  const confluence = [c1, c2, c3, c4, c5, c6].filter(Boolean).length;
  // Open interest (only where a <SYMBOL>_OI_<TF> file exists): did positions build up into the
  // sweep, and were they closed on the SFP bar (trapped traders stopped out / liquidated)?
  let oiFlushPct = null; let oiBuildPct = null;
  if (oi && idx > OI_BUILD_BARS) {
    const [now, prev, base] = [idx, idx - 1, idx - 1 - OI_BUILD_BARS].map((k) => oi.get(b[k].t));
    if (now !== undefined && prev !== undefined) oiFlushPct = (now / prev - 1) * 100;
    if (prev !== undefined && base !== undefined) oiBuildPct = (prev / base - 1) * 100;
  }

  return { prof, confluence, conf: { c1, c2, c3, c4, c5, c6 }, htf: daily.trend(date), atr: a, oiFlushPct, oiBuildPct };
}

// ---------- Trade simulation ----------
function simulate(b, idx, dir, entry, stop, target) {
  for (let j = idx + 1; j < b.length && j <= idx + MAX_HOLD; j += 1) {
    const { o, h, l } = b[j];
    if (dir === 1) {
      if (o <= stop) return { exit: o, j, why: 'stop' };
      if (o >= target) return { exit: o, j, why: 'target' };
      if (l <= stop) return { exit: stop, j, why: 'stop' }; // stop first if both touched
      if (h >= target) return { exit: target, j, why: 'target' };
    } else {
      if (o >= stop) return { exit: o, j, why: 'stop' };
      if (o <= target) return { exit: o, j, why: 'target' };
      if (h >= stop) return { exit: stop, j, why: 'stop' };
      if (l <= target) return { exit: target, j, why: 'target' };
    }
  }
  const j = Math.min(b.length - 1, idx + MAX_HOLD);
  if (j === idx) return null;
  return { exit: b[j].c, j, why: j === idx + MAX_HOLD ? 'time' : 'open' };
}

const EXITS = ['1R', '2R', '3R', 'POC', 'Playbook'];

function evaluate(b, idx, dir, cx) {
  const entry = b[idx].c;
  const stop = dir === 1 ? b[idx].l - STOP_BUFFER_ATR * cx.atr : b[idx].h + STOP_BUFFER_ATR * cx.atr;
  const risk = Math.abs(entry - stop);
  const costR = (2 * COST_PER_SIDE * entry) / risk;
  const R = (x) => (dir * (x.exit - entry)) / risk - costR;
  const out = { entry, stop, risk, costR, rrPoc: (dir * (cx.prof.poc - entry)) / risk };
  for (const e of EXITS) {
    let res = null;
    if (e.endsWith('R') && e !== 'POC') {
      const k = Number(e[0]);
      res = simulate(b, idx, dir, entry, stop, entry + dir * k * risk);
      if (res) res.r = R(res);
    } else if (out.rrPoc > 0) { // POC must be on the profit side
      const r1 = simulate(b, idx, dir, entry, stop, cx.prof.poc);
      if (e === 'POC') { res = r1; if (res) res.r = R(res); } else {
        // Playbook: half at POC, half at the opposite side of the range, original stop
        const r2 = simulate(b, idx, dir, entry, stop, dir === 1 ? cx.prof.rangeHigh : cx.prof.rangeLow);
        if (r1 && r2) res = { r: (R(r1) + R(r2)) / 2, j: Math.max(r1.j, r2.j), why: `${r1.why}/${r2.why}` };
      }
    }
    out[e] = res && res.why !== 'open' ? res : null; // drop trades still open at the data end
  }
  return out;
}

// ---------- Filters (protocol 7: add one at a time) ----------
const FILTERS = {
  baseline: () => true,
  'a) at range extreme': (s) => (s.dir === 1 ? s.level <= s.cx.prof.val + 0.1 * s.cx.atr : s.level >= s.cx.prof.vah - 0.1 * s.cx.atr),
  'b) confluence >= 3': (s) => s.cx.confluence >= 3,
  'c) HTF trend agrees': (s) => s.cx.htf === s.dir,
  'd) RR >= 2 to POC': (s) => s.res.rrPoc >= 2,
};
FILTERS['a+b+c+d'] = (s) => ['a) at range extreme', 'b) confluence >= 3', 'c) HTF trend agrees', 'd) RR >= 2 to POC'].every((f) => FILTERS[f](s));
if (SYMBOLS.some((sym) => TIMEFRAMES.some((tf) => fs.existsSync(path.join(DATA, `${sym}_OI_${tf}.json`))))) {
  FILTERS['e) OI flush on SFP bar'] = (s) => s.cx.oiFlushPct !== null && s.cx.oiFlushPct < 0;
  FILTERS['f) OI build-up before'] = (s) => s.cx.oiBuildPct !== null && s.cx.oiBuildPct > 0;
  FILTERS['e+f) OI trap'] = (s) => FILTERS['e) OI flush on SFP bar'](s) && FILTERS['f) OI build-up before'](s);
  FILTERS['c+e) HTF + OI flush'] = (s) => FILTERS['c) HTF trend agrees'](s) && FILTERS['e) OI flush on SFP bar'](s);
}

function stats(rs, times) {
  if (!rs.length) return { n: 0 };
  const wins = rs.filter((r) => r > 0);
  const pos = wins.reduce((s, x) => s + x, 0);
  const neg = -rs.filter((r) => r <= 0).reduce((s, x) => s + x, 0);
  const order = times.map((t, i) => [t, rs[i]]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  let eq = 0; let peak = 0; let dd = 0;
  order.forEach((r) => { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); });
  const half = Math.floor(order.length / 2);
  const m = mean(rs);
  return {
    n: rs.length,
    winRate: wins.length / rs.length,
    expR: m,
    ci95: 1.96 * sd(rs) / Math.sqrt(rs.length),
    pf: neg ? pos / neg : Infinity,
    totalR: eq,
    maxDD: dd,
    early: mean(order.slice(0, half)),
    late: mean(order.slice(half)),
  };
}

// ---------- Run ----------
function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const trades = [];
const control = [];
for (const L of PIVOT_LOOKBACKS) {
  for (const sym of SYMBOLS) {
    const daily = buildDaily(sym);
    for (const tf of TIMEFRAMES) {
      const b = load(sym, tf);
      const atr = atrSeries(b);
      const naked = buildNakedPocs(b);
      const piv = findSignals(b, L);
      const prefTPV = [0]; const prefV = [0];
      b.forEach((x, i) => { prefTPV[i + 1] = prefTPV[i] + ((x.h + x.l + x.c) / 3) * x.v; prefV[i + 1] = prefV[i] + x.v; });
      const oiFile = path.join(DATA, `${sym}_OI_${tf}.json`);
      const oi = fs.existsSync(oiFile) ? new Map(JSON.parse(fs.readFileSync(oiFile)).map((x) => [x[0], x[4]])) : null;
      const ctx = { daily, naked, piv, prefTPV, prefV, oi };
      const firstFrom = b.findIndex((x) => x.t >= FROM_T);
      if (firstFrom < 0) continue;
      const minIdx = Math.max(RANGE_BARS, 60, firstFrom);
      const endIdx = TO_T === Infinity ? b.length : b.findIndex((x) => x.t >= TO_T);
      const maxIdx = endIdx < 0 ? b.length : endIdx; // signals must be before this bar
      if (maxIdx <= minIdx) continue;

      piv.signals.filter((s) => s.idx >= minIdx && s.idx < maxIdx && atr[s.idx]).forEach((s) => {
        const cx = context(b, atr, ctx, s.idx, s.dir, s.level);
        if (!cx.prof) return;
        trades.push({ L, sym, tf, ...s, t: b[s.idx].t, cx, res: evaluate(b, s.idx, s.dir, cx) });
      });

      // random-entry control: same exits, entries on random bars, stop beyond that bar's wick
      const rnd = mulberry32(L * 1000 + SYMBOLS.indexOf(sym) * 10 + TIMEFRAMES.indexOf(tf));
      const nSig = trades.filter((x) => x.L === L && x.sym === sym && x.tf === tf).length;
      for (let k = 0; k < nSig * CONTROL_MULT; k += 1) {
        const idx = minIdx + Math.floor(rnd() * (Math.min(maxIdx, b.length - 1) - minIdx));
        const dir = rnd() < 0.5 ? 1 : -1;
        if (!atr[idx]) continue;
        const level = dir === 1 ? b[idx].l : b[idx].h;
        const cx = context(b, atr, ctx, idx, dir, level);
        if (!cx.prof) continue;
        control.push({ L, sym, tf, idx, dir, level, k, t: b[idx].t, cx, res: evaluate(b, idx, dir, cx) });
      }
    }
  }
  process.stderr.write(`pivot lookback ${L}: done\n`);
}

// ---------- Bar footprints: TradingView up/down volume by price for the entry bar ----------
// Rows are [priceLow, priceHigh, buyVolume, sellVolume], fetched by fetch-footprints.js.
const FP_DIR = path.join(DATA, 'footprints');
if (process.argv.includes('--list-footprints')) {
  // every real signal, plus one in three random-control entries
  const need = new Map();
  [...trades, ...control.filter((r) => r.k % CONTROL_MULT === 0)].forEach((r) => need.set(`${r.sym}|${r.tf}|${r.t}`, { sym: r.sym, tf: r.tf, t: r.t }));
  fs.mkdirSync(FP_DIR, { recursive: true });
  const file = path.join(FP_DIR, `needed-${path.basename(OUT)}.json`);
  fs.writeFileSync(file, JSON.stringify([...need.values()]));
  console.log(`${need.size} bars need a footprint -> ${path.relative(process.cwd(), file)}`);
  process.exit(0);
}
const fpCache = {};
function footprintFeatures(r) {
  const file = path.join(FP_DIR, `${r.sym}_${r.tf}.json`);
  if (!(file in fpCache)) fpCache[file] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
  const rows = fpCache[file]?.[r.t];
  if (!rows || rows.length < 5) return null; // < 5 rows: no intrabar data for that date
  let buy = 0; let sell = 0; let wBuy = 0; let wSell = 0;
  rows.forEach(([lo, hi, bv, sv]) => {
    buy += bv; sell += sv;
    const mid = (lo + hi) / 2;
    if (r.dir === 1 ? mid < r.level : mid > r.level) { wBuy += bv; wSell += sv; } // rows in the sweep wick
  });
  const total = buy + sell;
  if (!total) return null;
  const wick = wBuy + wSell;
  return {
    deltaPct: (r.dir * (buy - sell)) / total, // > 0: the bar's delta sides with the trade
    wickAggr: wick ? (r.dir === 1 ? wSell : wBuy) / wick : null, // share of breakout-side volume in the wick
    wickShare: wick / total, // how much of the bar's volume traded beyond the level
  };
}
const hasFootprints = fs.existsSync(FP_DIR) && fs.readdirSync(FP_DIR).some((f) => !f.startsWith('needed-'));
if (hasFootprints) {
  [...trades, ...control].forEach((r) => { r.fp = footprintFeatures(r); });
  FILTERS['footprint available'] = (s) => !!s.fp;
  FILTERS['g) delta flips to trade side'] = (s) => !!s.fp && s.fp.deltaPct > 0;
  FILTERS['h) trapped aggressors in wick'] = (s) => !!s.fp && s.fp.wickAggr !== null && s.fp.wickAggr > 0.5;
  FILTERS['g+h) trap + delta flip'] = (s) => FILTERS['g) delta flips to trade side'](s) && FILTERS['h) trapped aggressors in wick'](s);
}

// ---------- Summaries ----------
const summary = [];
const group = (rows, keyFn) => { const m = new Map(); rows.forEach((r) => { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return m; };
const add = (scope, rows, filter, exit, extra = {}) => {
  const sel = rows.filter((r) => r.res[exit] && FILTERS[filter](r));
  summary.push({ scope, filter, exit, ...extra, ...stats(sel.map((r) => r.res[exit].r), sel.map((r) => r.t)) });
};
for (const L of PIVOT_LOOKBACKS) {
  const tr = trades.filter((r) => r.L === L);
  const co = control.filter((r) => r.L === L);
  for (const exit of EXITS) {
    for (const f of Object.keys(FILTERS)) add('all', tr, f, exit, { L });
    for (const f of Object.keys(FILTERS)) add('control (random entries)', co, f, exit, { L });
    for (const [tf, rows] of group(tr, (r) => r.tf)) for (const f of Object.keys(FILTERS)) add(`tf ${tf}`, rows, f, exit, { L });
    for (const [tf, rows] of group(co, (r) => r.tf)) for (const f of Object.keys(FILTERS)) add(`control tf ${tf}`, rows, f, exit, { L });
    for (const [d, rows] of group(tr, (r) => (r.dir === 1 ? 'long' : 'short'))) for (const f of Object.keys(FILTERS)) add(d, rows, f, exit, { L });
    for (const [d, rows] of group(co, (r) => (r.dir === 1 ? 'long' : 'short'))) for (const f of Object.keys(FILTERS)) add(`control ${d}`, rows, f, exit, { L });
    for (const [s, rows] of group(tr, (r) => r.sym)) { add(`sym ${s}`, rows, 'baseline', exit, { L }); add(`sym ${s}`, rows, 'a+b+c+d', exit, { L }); }
  }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
const cols = ['L', 'sym', 'tf', 'dir', 'date', 'level', 'entry', 'stop', 'riskPct', 'rrPoc', 'confluence', 'c1_profile', 'c2_nakedPoc', 'c3_fib', 'c4_avwap', 'c5_htfLevel', 'c6_srFlip', 'htfTrend', 'atRangeExtreme', 'oiFlushPct', 'oiBuildPct', 'fpDeltaPct', 'fpWickAggr', 'fpWickShare', ...EXITS.map((e) => `R_${e}`)];
const csv = [cols.join(',')].concat(trades.map((r) => [
  r.L, r.sym, r.tf, r.dir === 1 ? 'long' : 'short', new Date(r.t * 1000).toISOString().slice(0, 16), r.level.toFixed(2), r.res.entry.toFixed(2), r.res.stop.toFixed(2),
  ((100 * r.res.risk) / r.res.entry).toFixed(2), r.res.rrPoc.toFixed(2), r.cx.confluence, ...Object.values(r.cx.conf).map(Number), r.cx.htf, Number(FILTERS['a) at range extreme'](r)), r.cx.oiFlushPct?.toFixed(3) ?? '', r.cx.oiBuildPct?.toFixed(3) ?? '',
  r.fp?.deltaPct.toFixed(3) ?? '', r.fp?.wickAggr?.toFixed(3) ?? '', r.fp?.wickShare.toFixed(3) ?? '',
  ...EXITS.map((e) => (r.res[e] ? r.res[e].r.toFixed(3) : '')),
].join(',')));
fs.writeFileSync(path.join(OUT, 'trades.csv'), csv.join('\n'));
console.log(JSON.stringify({ trades: trades.length, control: control.length }));
