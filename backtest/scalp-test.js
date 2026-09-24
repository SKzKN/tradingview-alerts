// Scalp test: sweep-and-reclaim setups around session opens, on short candles.
//   Levels:  prior-session high/low (PSH/PSL) and opening ranges (first 30 min after an open)
//   Setups:  SFP (one candle wicks through the level and closes back) and failed break (a close
//            through the level, then a close back within MAX_WAIT candles). Long and short.
//   Exits:   1R / 1.5R / 2R / session VWAP, stop beyond the sweep extreme, hard time exit.
//   Control: random entries in the same minutes with the same stop and exit rules.
// Usage: node scalp-test.js --inst stocks --tf 15 --split 2026-05-01
//        node scalp-test.js --inst silver --tf 30 --split 2026-05-01
const fs = require('fs');
const path = require('path');
const T = require('./trap-analysis');

const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const INST = arg('--inst', 'stocks');
const TF = arg('--tf', '15');
const SPLIT_T = Date.parse(`${arg('--split', '2026-05-01')}T00:00:00Z`) / 1000;
const tfMin = Number(TF);
const CFG = {
  stocks: {
    symbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'IREN', 'NBIS'],
    cost: Number(arg('--cost', 0.0005)),
    sessionKey: (t) => nyParts(t).date, // 09:30-16:00 ET, one calendar day
    opens: [{ label: 'open', h: 9, m: 30 }],
    levelWindowMin: 90, // PSH/PSL reclaims count only within this many minutes of the open
    orWindowMin: 90, // opening-range fake-outs count within this many minutes after the range forms
    timeExitHM: [12, 0], // flat by this ET time
    maxHold: Math.round(150 / tfMin),
  },
  silver: {
    symbols: ['SI1!'],
    cost: Number(arg('--cost', 0.0002)),
    sessionKey: (t) => nyParts(t + 6 * 3600).date, // 18:00-17:00 ET
    opens: [{ label: 'Globex', h: 18, m: 0 }, { label: 'London', h: 3, m: 0 }, { label: 'COMEX', h: 8, m: 0 }],
    levelWindowMin: null, // any time; bucketed by hour in the report
    orWindowMin: 90,
    timeExitHM: null,
    maxHold: Math.round(240 / tfMin),
  },
}[INST];
const OR_MIN = 30; // opening range length
const MAX_WAIT = Math.max(2, Math.round(45 / tfMin)); // candles a break has to reclaim in (45 min)
const STOP_BUFFER_ATR = 0.1; const MIN_RISK_ATR = 0.5;
const OUT = path.join(__dirname, '..', 'results', 'scalp');

const nyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function nyParts(t) { const o = Object.fromEntries(nyFmt.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value])); return { date: `${o.year}-${o.month}-${o.day}`, h: Number(o.hour) % 24, m: Number(o.minute) }; }
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1)); };
const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
const hourBucket = (h) => (h >= 18 || h < 2 ? 'Asia 18-02' : h < 7 ? 'London 02-07' : h < 10 ? 'COMEX 07-10' : h < 14 ? 'NY 10-14' : 'late 14-17');

function simulate(bars, idx, dir, entry, stop, target, cost) {
  const risk = Math.abs(entry - stop); const costR = (2 * cost * entry) / risk;
  for (let j = idx + 1; j < bars.length && j <= idx + CFG.maxHold; j += 1) {
    const b = bars[j];
    const so = dir === 1 ? b.o <= stop : b.o >= stop; const to = target !== null && (dir === 1 ? b.o >= target : b.o <= target);
    if (so || to) return (dir * (b.o - entry)) / risk - costR;
    if (dir === 1 ? b.l <= stop : b.h >= stop) return -1 - costR;
    if (target !== null && (dir === 1 ? b.h >= target : b.l <= target)) return (dir * (target - entry)) / risk - costR;
    const timeUp = j === idx + CFG.maxHold || (CFG.timeExitHM && b.ny.h * 60 + b.ny.m >= CFG.timeExitHM[0] * 60 + CFG.timeExitHM[1]) || b.sess !== bars[idx].sess;
    if (timeUp) return (dir * (b.c - entry)) / risk - costR;
  }
  return null;
}

const events = []; const control = []; let seed = 3;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

for (const sym of CFG.symbols) {
  const bars = T.loadSeries(sym, TF);
  // session bookkeeping: index within session, VWAP, prior-session H/L, opening ranges
  let sess = null; let idx = 0; let cumPV = 0; let cumV = 0; let sH = -Infinity; let sL = Infinity; let prev = null;
  const levelsBySess = new Map(); const ors = []; // active opening-range accumulators
  bars.forEach((b, i) => {
    b.ny = nyParts(b.t); const k = CFG.sessionKey(b.t);
    if (k !== sess) { if (sess !== null) prev = { h: sH, l: sL }; sess = k; idx = 0; cumPV = 0; cumV = 0; sH = -Infinity; sL = Infinity; ors.length = 0; if (prev) levelsBySess.set(k, [{ price: prev.l, side: 1, kind: 'PSL', from: i, until: CFG.levelWindowMin ? i + Math.round(CFG.levelWindowMin / tfMin) - 1 : Infinity }, { price: prev.h, side: -1, kind: 'PSH', from: i, until: CFG.levelWindowMin ? i + Math.round(CFG.levelWindowMin / tfMin) - 1 : Infinity }]); else levelsBySess.set(k, []); } else idx += 1;
    b.sess = k; b.sidx = idx; sH = Math.max(sH, b.h); sL = Math.min(sL, b.l);
    cumPV += ((b.h + b.l + b.c) / 3) * b.v; cumV += b.v; b.vwap = cumV ? cumPV / cumV : b.c;
    // opening ranges: start at an open, publish after OR_MIN minutes
    CFG.opens.forEach((op) => { if (b.ny.h === op.h && b.ny.m === op.m) ors.push({ label: op.label, n: 0, h: -Infinity, l: Infinity }); });
    for (let q = ors.length - 1; q >= 0; q -= 1) {
      const o = ors[q]; o.n += 1; o.h = Math.max(o.h, b.h); o.l = Math.min(o.l, b.l);
      if (o.n * tfMin >= OR_MIN) { const until = i + Math.round(CFG.orWindowMin / tfMin); levelsBySess.get(k).push({ price: o.l, side: 1, kind: `OR-${o.label}`, from: i + 1, until }, { price: o.h, side: -1, kind: `OR-${o.label}`, from: i + 1, until }); ors.splice(q, 1); }
    }
  });
  // detect setups
  for (const [k, levels] of levelsBySess) {
    for (const lv of levels) {
      let pending = null; let consumed = false;
      for (let i = lv.from; i < bars.length && i <= lv.until && bars[i].sess === k; i += 1) {
        const b = bars[i]; const dir = lv.side; // +1 = long at a low, -1 = short at a high
        if (!b.atr || !b.avgV || b.delta === null) continue;
        const beyond = (x) => (dir === 1 ? x.c < lv.price : x.c > lv.price);
        const wick = dir === 1 ? b.l < lv.price : b.h > lv.price;
        let sig = null;
        if (pending) {
          if (!beyond(b)) { sig = { type: 'failed break', from: pending }; pending = null; consumed = true; } else if (i - pending >= MAX_WAIT) { pending = null; consumed = true; }
        } else if (!consumed) {
          const prevBeyond = i > 0 && beyond(bars[i - 1]);
          if (beyond(b) && !prevBeyond) pending = i;
          else if (wick && !beyond(b) && !prevBeyond) { sig = { type: 'SFP', from: i }; consumed = true; }
        }
        if (!sig) continue;
        const sweep = bars.slice(sig.from, i + 1);
        const extreme = dir === 1 ? Math.min(...sweep.map((x) => x.l)) : Math.max(...sweep.map((x) => x.h));
        const entry = b.c; let stop = extreme - dir * STOP_BUFFER_ATR * b.atr;
        if (Math.abs(entry - stop) < MIN_RISK_ATR * b.atr) stop = entry - dir * MIN_RISK_ATR * b.atr;
        const risk = Math.abs(entry - stop);
        const vwapTarget = dir * (b.vwap - entry) >= 0.25 * risk ? b.vwap : null;
        const ev = {
          sym, t: b.t, w: b.t < SPLIT_T ? 'dev' : 'val', kind: lv.kind, level: lv.price, setup: sig.type, dir, candles: i - sig.from + 1, sidx: b.sidx, hour: b.ny.h, bucket: hourBucket(b.ny.h),
          deltaOk: dir * b.deltaPct > 0, sweepVolMult: sweep.reduce((s, x) => s + x.v, 0) / b.avgV / sweep.length, entry, stop, riskPct: (100 * risk) / entry, vwapDistR: dir * (b.vwap - entry) / risk,
          R1: simulate(bars, i, dir, entry, stop, entry + dir * risk, CFG.cost), R15: simulate(bars, i, dir, entry, stop, entry + dir * 1.5 * risk, CFG.cost), R2: simulate(bars, i, dir, entry, stop, entry + dir * 2 * risk, CFG.cost),
          RV: vwapTarget === null ? null : simulate(bars, i, dir, entry, stop, vwapTarget, CFG.cost),
        };
        events.push(ev);
      }
    }
  }
  // capitulation / squeeze: one-sided candle on >= 2x volume inside 30 min of an open, confirmed by the next
  // candle closing back through the flush candle's midpoint; entry at that confirming close
  const openMinutes = (b) => CFG.opens.some((op) => { const d = (b.ny.h * 60 + b.ny.m) - (op.h * 60 + op.m); return d >= 0 && d < 30; });
  for (let i = 1; i < bars.length - 1; i += 1) {
    const b = bars[i]; const n = bars[i + 1];
    if (!b.atr || !b.avgV || b.delta === null || !openMinutes(b) || n.sess !== b.sess) continue;
    for (const dir of [1, -1]) {
      const flush = b.v >= 2 * b.avgV && dir * b.deltaPct <= -0.3 && (dir === 1 ? b.c < b.o : b.c > b.o);
      const confirmed = dir === 1 ? n.c > (b.h + b.l) / 2 : n.c < (b.h + b.l) / 2;
      if (!flush || !confirmed) continue;
      const entry = n.c; let stop = (dir === 1 ? Math.min(b.l, n.l) : Math.max(b.h, n.h)) - dir * STOP_BUFFER_ATR * b.atr;
      if (Math.abs(entry - stop) < MIN_RISK_ATR * b.atr) stop = entry - dir * MIN_RISK_ATR * b.atr;
      const risk = Math.abs(entry - stop); const vt = dir * (n.vwap - entry) >= 0.25 * risk ? n.vwap : null;
      events.push({ sym, t: n.t, w: n.t < SPLIT_T ? 'dev' : 'val', kind: dir === 1 ? 'FLUSH-sell' : 'FLUSH-buy', level: (b.h + b.l) / 2, setup: 'capitulation', dir, candles: 2, sidx: n.sidx, hour: n.ny.h, bucket: hourBucket(n.ny.h), deltaOk: dir * n.deltaPct > 0, sweepVolMult: b.v / b.avgV, entry, stop, riskPct: (100 * risk) / entry, vwapDistR: dir * (n.vwap - entry) / risk,
        R1: simulate(bars, i + 1, dir, entry, stop, entry + dir * risk, CFG.cost), R15: simulate(bars, i + 1, dir, entry, stop, entry + dir * 1.5 * risk, CFG.cost), R2: simulate(bars, i + 1, dir, entry, stop, entry + dir * 2 * risk, CFG.cost), RV: vt === null ? null : simulate(bars, i + 1, dir, entry, stop, vt, CFG.cost) });
    }
  }
  // random control in the same session minutes as the setups
  const minutes = new Set(events.filter((e) => e.sym === sym).map((e) => e.sidx));
  const pool = bars.map((b, i) => i).filter((i) => bars[i].atr && bars[i].avgV && bars[i].delta !== null && minutes.has(bars[i].sidx));
  const nSig = events.filter((e) => e.sym === sym).length;
  for (let q = 0; q < nSig * 3 && pool.length; q += 1) {
    const i = pool[Math.floor(rnd() * pool.length)]; const b = bars[i]; const dir = rnd() < 0.5 ? 1 : -1;
    const entry = b.c; let stop = (dir === 1 ? b.l : b.h) - dir * STOP_BUFFER_ATR * b.atr; if (Math.abs(entry - stop) < MIN_RISK_ATR * b.atr) stop = entry - dir * MIN_RISK_ATR * b.atr; const risk = Math.abs(entry - stop);
    const vt = dir * (b.vwap - entry) >= 0.25 * risk ? b.vwap : null;
    control.push({ w: b.t < SPLIT_T ? 'dev' : 'val', dir, bucket: hourBucket(b.ny.h), R1: simulate(bars, i, dir, entry, stop, entry + dir * risk, CFG.cost), R15: simulate(bars, i, dir, entry, stop, entry + dir * 1.5 * risk, CFG.cost), R2: simulate(bars, i, dir, entry, stop, entry + dir * 2 * risk, CFG.cost), RV: vt === null ? null : simulate(bars, i, dir, entry, stop, vt, CFG.cost) });
  }
}

// ---------- report ----------
const st = (evs) => {
  const cols = ['R1', 'R15', 'R2', 'RV'].map((k) => evs.map((e) => e[k]).filter((x) => x !== null));
  if (!cols[0].length) return 'n=0';
  return `n=${String(cols[0].length).padEnd(4)}` + cols.map((v, i) => (v.length ? `${['1R', '1.5R', '2R', 'VWAP'][i]} ${(100 * v.filter((x) => x > 0).length / v.length).toFixed(0).padStart(3)}% ${f(mean(v))}±${(1.96 * sd(v) / Math.sqrt(v.length)).toFixed(2)}` : `${['1R', '1.5R', '2R', 'VWAP'][i]} n/a`).padEnd(22)).join('');
};
const row = (label, evs) => { for (const w of ['dev', 'val']) console.log(`  ${(w === 'dev' ? label : '').padEnd(46)} ${w === 'dev' ? 'dev' : 'val'}: ${st(evs.filter((e) => e.w === w))}`); };
console.log(`\n${INST} ${TF}-minute: ${events.length} setups (${events.filter((e) => e.w === 'dev').length} dev before ${arg('--split', '2026-05-01')}, ${events.filter((e) => e.w === 'val').length} val), ${control.length} random entries, costs ${(100 * CFG.cost).toFixed(2)}%/side\n`);
for (const dir of [1, -1]) {
  const D = events.filter((e) => e.dir === dir); const C = control.filter((c) => c.dir === dir);
  console.log(`=============== ${dir === 1 ? 'LONGS (sweeps of lows)' : 'SHORTS (sweeps of highs)'} ===============`);
  row('random entries, same minutes', C);
  row('all setups', D);
  for (const kind of [...new Set(D.map((e) => e.kind))].sort()) for (const setup of ['SFP', 'failed break', 'capitulation']) {
    const S = D.filter((e) => e.kind === kind && e.setup === setup);
    if (!S.length) continue;
    row(`${kind} ${setup}`, S); row(`${kind} ${setup} + delta agrees`, S.filter((e) => e.deltaOk));
  }
  if (INST === 'silver') { console.log('  -- PSL/PSH setups by session phase --'); for (const bk of ['Asia 18-02', 'London 02-07', 'COMEX 07-10', 'NY 10-14', 'late 14-17']) { row(`${bk}`, D.filter((e) => e.kind.startsWith('PS') && e.bucket === bk)); row(`${bk} random`, C.filter((c) => c.bucket === bk)); } }
  else { console.log('  -- PSL/PSH setups by reclaim time --'); for (const [lab, fn] of [['first 30 min', (e) => e.sidx * tfMin < 30], ['30-60 min', (e) => e.sidx * tfMin >= 30 && e.sidx * tfMin < 60], ['60-90 min', (e) => e.sidx * tfMin >= 60]]) row(lab, D.filter((e) => e.kind.startsWith('PS') && fn(e))); }
}
fs.mkdirSync(OUT, { recursive: true });
const cols = ['sym', 'time', 'window', 'kind', 'level', 'setup', 'dir', 'candles', 'sessionCandle', 'hourET', 'deltaAgrees', 'sweepVolMult', 'entry', 'stop', 'riskPct', 'vwapDistR', 'R_1R', 'R_1.5R', 'R_2R', 'R_VWAP'];
fs.writeFileSync(path.join(OUT, `${INST}_${TF}m_events.csv`), [cols.join(',')].concat(events.sort((a, b) => a.t - b.t).map((e) => [e.sym, new Date(e.t * 1000).toISOString().slice(0, 16).replace('T', ' '), e.w, e.kind, e.level.toFixed(3), e.setup, e.dir === 1 ? 'long' : 'short', e.candles, e.sidx, e.hour, +e.deltaOk, e.sweepVolMult.toFixed(2), e.entry.toFixed(3), e.stop.toFixed(3), e.riskPct.toFixed(2), e.vwapDistR.toFixed(2), ...['R1', 'R15', 'R2', 'RV'].map((k) => (e[k] === null ? '' : e[k].toFixed(3)))].join(','))).join('\n'));
console.log(`\nEvents written to results/scalp/${INST}_${TF}m_events.csv`);
