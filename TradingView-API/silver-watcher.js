// Silver "trapped shorts" watcher: the rule that held in both 2025 and 2026 in the backtest.
//   Level:    prior-session low (session 18:00-17:00 ET) or an unswept 5-candle swing low, 1H candles
//   Setup:    a close below the level (breakdown), then a close back above it within MAX_WAIT candles
//   Window:   the reclaim candle opens in the Asia session, 18:00-02:00 ET
//   Entry:    close of the reclaim candle
//   Stop:     lowest low of the sweep - 0.1 ATR (at least 0.5 ATR from entry)
//   Exits:    1R, 2R, or the close after TIME_STOP candles
// Usage:  node silver-watcher.js             watch live (console only if no webhook in ../.env)
//         node silver-watcher.js --history   replay the loaded history and print what would have fired
//         node silver-watcher.js --test      send one test message to Discord
const path = require('path');
const TradingView = require('./main');

// ---------- settings ----------
const SYMBOL = 'COMEX:SI1!';
const TIMEFRAME = '60';
const HISTORY = 3000; // candles to load (~5 months)
const WINDOW_HOURS_ET = [18, 19, 20, 21, 22, 23, 0, 1]; // reclaim candle must open in one of these
const MAX_WAIT = 8; // candles a breakdown has to reclaim in
const PIVOT_L = 5;
const MAX_LEVEL_AGE = 200;
const TIME_STOP = 24; // candles
const STOP_BUFFER_ATR = 0.1;
const MIN_RISK_ATR = 0.5;
const VOL_AVG = 20;
const SFP_ALERTS = false; // also flag one-candle wick reclaims (the stock SFP rule; on silver the replay shows they mostly stop out)
const OUNCES = { full: 5000, micro: 1000 };

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env yet */ }
const { makeDiscord, log, GREEN, RED, GREY, BLUE } = require('./discord');
const discord = makeDiscord((process.env.DISCORD_WEBHOOK_URL || '').trim(), 'Silver Trap Watcher');
const HISTORY_MODE = process.argv.includes('--history');
const p = (v) => v.toFixed(3);
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

// ---------- time helpers (CME session = 18:00-17:00 New York) ----------
const nyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
const ny = (t) => { const o = Object.fromEntries(nyFmt.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value])); return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 }; };
const sessionOf = (t) => ny(t + 6 * 3600).date;
const inWindow = (t) => WINDOW_HOURS_ET.includes(ny(t).hour);
const when = (t) => `${new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC (${String(ny(t).hour).padStart(2, '0')}:00 ET)`;

// ---------- strategy state machine, fed one CLOSED candle at a time ----------
class Strategy {
  constructor(onSignal) {
    this.onSignal = onSignal;
    this.bars = []; this.levels = []; this.pending = []; this.atr = null; this.vols = [];
    this.session = null; this.sessLow = Infinity; this.armed = false; this.batch = [];
  }

  push(c) { // c = { t, o, h, l, c, v }
    const bars = this.bars; const n = bars.length; bars.push(c);
    // ATR(14), average volume
    if (n > 0) { const pc = bars[n - 1].c; const tr = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)); this.atr = this.atr === null ? tr : (this.atr * 13 + tr) / 14; }
    this.vols.push(c.v); if (this.vols.length > VOL_AVG) this.vols.shift();
    c.avgV = this.vols.length === VOL_AVG ? mean(this.vols) : null;
    // prior-session low becomes a level at the first candle of a new session
    const s = sessionOf(c.t);
    if (s !== this.session) { if (this.session !== null && Number.isFinite(this.sessLow)) this.levels.push({ price: this.sessLow, idx: n - 1, kind: 'prior-session low' }); this.session = s; this.sessLow = Infinity; }
    this.sessLow = Math.min(this.sessLow, c.l);
    // swing low confirmed PIVOT_L candles later
    const i = n - PIVOT_L;
    if (i >= PIVOT_L) {
      let ok = true;
      for (let k = i - PIVOT_L; k <= i + PIVOT_L; k += 1) { if (k === i) continue; if (k < i ? bars[k].l <= bars[i].l : bars[k].l < bars[i].l) { ok = false; break; } }
      if (ok) this.levels.push({ price: bars[i].l, idx: i, kind: 'swing low' });
    }
    // pending breakdowns: reclaimed, or expired
    for (let k = this.pending.length - 1; k >= 0; k -= 1) {
      const b = this.pending[k];
      if (c.c > b.level) { this.pending.splice(k, 1); this.signal('failed breakdown', b, n, c); } else if (n - b.idx >= MAX_WAIT) this.pending.splice(k, 1);
    }
    // new breakdowns (first close below an active level) and one-candle SFPs
    for (let k = this.levels.length - 1; k >= 0; k -= 1) {
      const lv = this.levels[k];
      if (n - lv.idx > MAX_LEVEL_AGE) { this.levels.splice(k, 1); continue; }
      if (n <= lv.idx + (lv.kind === 'swing low' ? PIVOT_L : 0)) continue;
      const prevBelow = bars[n - 1].c < lv.price;
      if (c.c < lv.price && !prevBelow) { this.levels.splice(k, 1); this.pending.push({ level: lv.price, kind: lv.kind, idx: n }); }
      else if (SFP_ALERTS && c.l < lv.price && c.c > lv.price && !prevBelow) { this.levels.splice(k, 1); this.signal('SFP wick reclaim', { level: lv.price, kind: lv.kind, idx: n }, n, c); }
    }
    // one alert per candle: several levels can sit at almost the same price
    if (this.batch.length) {
      const best = this.batch.sort((a, b) => (b.type === 'failed breakdown') - (a.type === 'failed breakdown') || b.trapped - a.trapped)[0];
      this.batch = [];
      this.onSignal(best);
    }
  }

  signal(type, b, n, c) {
    if (!this.armed || !this.atr || !c.avgV) return;
    const sweep = this.bars.slice(b.idx, n + 1);
    const sweepLow = Math.min(...sweep.map((x) => x.l));
    // volume that traded below the level during the sweep (candle volume x share of its range below the level)
    const trapped = sweep.reduce((s, x) => s + x.v * Math.max(0, Math.min(1, (b.level - x.l) / ((x.h - x.l) || 1))), 0) / c.avgV;
    const entry = c.c;
    let stop = sweepLow - STOP_BUFFER_ATR * this.atr;
    if (entry - stop < MIN_RISK_ATR * this.atr) stop = entry - MIN_RISK_ATR * this.atr;
    const risk = entry - stop;
    this.batch.push({ type, level: b.level, kind: b.kind, candles: n - b.idx, t: c.t, idx: n, entry, stop, risk, t1: entry + risk, t2: entry + 2 * risk, sweepLow, trapped, atr: this.atr, inWindow: inWindow(c.t) });
  }
}

// ---------- message ----------
function describe(sig, ctx) {
  const ok = (b) => (b ? '✅' : '❌');
  return [
    `**${sig.type}** of the ${sig.kind} at **${p(sig.level)}**, reclaimed in ${sig.candles} candle${sig.candles > 1 ? 's' : ''}`,
    `${ok(sig.inWindow)} Asia window (18:00-02:00 ET): reclaim candle opened ${when(sig.t)}`,
    `${ok(sig.trapped >= 1)} volume traded below the level: ${sig.trapped.toFixed(1)}x an average hour (estimated from candle ranges)`,
    ctx.dxy === null ? '▫️ DXY: n/a' : `${ok(ctx.dxy < 0)} DXY over the last ${ctx.dxyHours}h: ${ctx.dxy >= 0 ? '+' : ''}${(100 * ctx.dxy).toFixed(2)}%`,
    ctx.daily === null ? '' : `▫️ daily trend: last close ${ctx.daily > 0 ? 'above' : 'below'} the 50-day average`,
    '',
    `**Entry** ${p(sig.entry)} (reclaim close)`,
    `**Stop** ${p(sig.stop)}  (risk ${p(sig.risk)} = ${(100 * sig.risk / sig.entry).toFixed(2)}%; $${Math.round(sig.risk * OUNCES.micro)} per micro, $${Math.round(sig.risk * OUNCES.full)} per full contract)`,
    `**1R** ${p(sig.t1)}   **2R** ${p(sig.t2)}   time stop: close of candle ${TIME_STOP} after entry`,
    sig.type === 'SFP wick reclaim' ? '\n⚠️ one-candle SFP: validated on stocks, not tested on silver' : '',
  ].filter((x) => x !== '').join('\n');
}

// ---------- history mode: replay and score ----------
function replay(bars, ctxAt) {
  const out = [];
  const st = new Strategy((sig) => out.push(sig));
  bars.forEach((c, i) => { if (i === 60) st.armed = true; st.push(c); });
  const fired = out.filter((s) => s.inWindow);
  console.log(`\nReplayed ${bars.length} candles (${when(bars[0].t)} to ${when(bars[bars.length - 1].t)}): ${out.length} reclaims, ${fired.length} inside the Asia window\n`);
  let sum = 0; let n = 0;
  for (const s of fired) {
    let res = 'open'; let r = null;
    for (let j = s.idx + 1; j < bars.length && j <= s.idx + TIME_STOP; j += 1) {
      const b = bars[j];
      if (b.l <= s.stop) { res = 'stopped'; r = -1; break; }
      if (b.h >= s.t2) { res = '2R hit'; r = 2; break; }
      if (j === s.idx + TIME_STOP) { res = 'time stop'; r = (b.c - s.entry) / s.risk; }
    }
    if (r !== null) { sum += r; n += 1; }
    const ctx = ctxAt(s);
    console.log(`${when(s.t)}  ${s.type.padEnd(17)} ${s.kind.padEnd(18)} level ${p(s.level)}  entry ${p(s.entry)} stop ${p(s.stop)} 1R ${p(s.t1)} 2R ${p(s.t2)}  trapped ${s.trapped.toFixed(1)}x  DXY ${ctx.dxy === null ? 'n/a' : `${(100 * ctx.dxy).toFixed(2)}%`}  -> ${res}${r !== null ? ` (${r >= 0 ? '+' : ''}${r.toFixed(2)}R, 2R-or-stop)` : ''}`);
  }
  if (n) console.log(`\n${n} resolved: average ${(sum / n >= 0 ? '+' : '')}${(sum / n).toFixed(2)}R per trade with 2R-or-stop exits, ${fired.filter((s) => s.idx + 1 < bars.length && bars.slice(s.idx + 1, s.idx + TIME_STOP + 1).some((b) => b.h >= s.t1) && !bars.slice(s.idx + 1, s.idx + TIME_STOP + 1).some((b, k, arr) => b.l <= s.stop && !arr.slice(0, k).some((x) => x.h >= s.t1))).length}/${fired.length} reached 1R before the stop`);
}

// ---------- live ----------
async function main() {
  const client = new TradingView.Client();
  let stopping = false;
  client.onDisconnected(() => { if (!stopping) { log('Disconnected, exiting so the launcher restarts'); process.exit(1); } });
  client.onError((...e) => log('Client error:', ...e));

  const dxyCloses = new Map(); // candle time -> DXY close
  const dxyChart = new client.Session.Chart();
  dxyChart.onError((...e) => log('DXY chart error:', ...e));
  dxyChart.onUpdate(() => dxyChart.periods.forEach((x) => dxyCloses.set(x.time, x.close)));
  dxyChart.setMarket('TVC:DXY', { timeframe: TIMEFRAME, range: HISTORY });

  let dailyTrend = null;
  const dailyChart = new client.Session.Chart();
  dailyChart.onError((...e) => log('Daily chart error:', ...e));
  dailyChart.onUpdate(() => { const d = [...dailyChart.periods].reverse(); if (d.length > 51) { const closes = d.slice(-51, -1).map((x) => x.close); dailyTrend = closes[closes.length - 1] > mean(closes) ? 1 : -1; } });
  dailyChart.setMarket(SYMBOL, { timeframe: 'D', range: 80 });

  const chart = new client.Session.Chart();
  chart.onError((...e) => { log('Chart error:', ...e); discord('⚠️ Silver watcher', `Chart error: ${e.join(' ')}`, GREY); });
  chart.setMarket(SYMBOL, { timeframe: TIMEFRAME, range: HISTORY });

  const toBar = (x) => ({ t: x.time, o: x.open, h: x.max, l: x.min, c: x.close, v: x.volume || 0 });
  const ctxAt = (sig) => { // DXY change over the sweep, at least the last 4 hours
    const hours = Math.max(sig.candles, 4); let a; for (let h = hours; h <= hours + 3 && a === undefined; h += 1) a = dxyCloses.get(sig.t - h * 3600);
    const b = dxyCloses.get(sig.t); return { dxy: a && b ? b / a - 1 : null, dxyHours: hours, daily: dailyTrend };
  };

  const open = []; // trades being followed
  const strategy = new Strategy((sig) => {
    if (!sig.inWindow) { log(`reclaim outside the window, ignored: ${sig.type} ${p(sig.level)} at ${when(sig.t)}`); return; }
    const ctx = ctxAt(sig);
    log(`SIGNAL ${sig.type} level ${p(sig.level)} entry ${p(sig.entry)} stop ${p(sig.stop)}`);
    discord(`🔔 Silver: ${sig.type} in the Asia window`, describe(sig, ctx), sig.type === 'failed breakdown' ? GREEN : BLUE);
    open.push({ ...sig, hit1: false, closedCandles: 0 });
  });

  let ready = false; let idle; let lastClosed = 0;
  chart.onUpdate(() => {
    const periods = [...chart.periods].reverse();
    if (periods.length < 2) return;
    if (!ready) { // wait until the history has finished arriving, then build state silently
      clearTimeout(idle);
      idle = setTimeout(() => {
        const hist = [...chart.periods].reverse().slice(0, -1).map(toBar);
        if (HISTORY_MODE) { replay(hist, ctxAt); stopping = true; client.end(); process.exit(0); }
        hist.forEach((c) => strategy.push(c));
        lastClosed = hist[hist.length - 1].t; strategy.armed = true; ready = true;
        const live = periods[periods.length - 1];
        log(`Ready: ${hist.length} candles of history, last price ${p(live.close)}, ${strategy.levels.length} active levels, ${strategy.pending.length} pending breakdown(s). Session ${sessionOf(live.time)}, ${inWindow(live.time) ? 'INSIDE' : 'outside'} the Asia window.`);
        discord('✅ Silver trap watcher started', `Watching ${SYMBOL} ${TIMEFRAME}-minute candles. Levels tracked: ${strategy.levels.map((l) => p(l.price)).slice(-6).join(', ')}${strategy.pending.length ? `\nPending breakdown below ${strategy.pending.map((b) => p(b.level)).join(', ')}: a close back above inside 18:00-02:00 ET would be a signal.` : ''}`, GREY);
      }, 3000);
      return;
    }
    // closed candles that are new since the last update
    const closed = periods.slice(0, -1).filter((x) => x.time > lastClosed).map(toBar);
    closed.forEach((c) => { strategy.push(c); lastClosed = c.t; open.forEach((o) => { o.closedCandles += 1; }); });
    // follow open trades on the live candle
    const live = toBar(periods[periods.length - 1]);
    for (let k = open.length - 1; k >= 0; k -= 1) {
      const o = open[k];
      const rNow = (live.c - o.entry) / o.risk;
      if (live.l <= o.stop) { discord(`🛑 Silver: stopped out (${p(o.stop)})`, `Trade from ${when(o.t)}, entry ${p(o.entry)}: -1R${o.hit1 ? ' (1R had been reached)' : ''}`, RED); open.splice(k, 1); continue; }
      if (live.h >= o.t2) { discord(`🎯 Silver: 2R reached (${p(o.t2)})`, `Trade from ${when(o.t)}, entry ${p(o.entry)}. Done.`, GREEN); open.splice(k, 1); continue; }
      if (!o.hit1 && live.h >= o.t1) { o.hit1 = true; discord(`✅ Silver: 1R reached (${p(o.t1)})`, `Trade from ${when(o.t)}, entry ${p(o.entry)}. Still following for 2R at ${p(o.t2)}, stop ${p(o.stop)}.`, GREEN); }
      if (o.closedCandles >= TIME_STOP) { discord(`⏱️ Silver: time stop`, `Trade from ${when(o.t)}: ${TIME_STOP} candles passed. Price ${p(live.c)} = ${rNow >= 0 ? '+' : ''}${rNow.toFixed(2)}R. Exit at this close.`, GREY); open.splice(k, 1); }
    }
  });

  const stop = () => { stopping = true; log('Stopping'); client.end(); discord('⏹️ Silver trap watcher stopped', 'No silver alerts until it is started again.', GREY).then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = { Strategy, describe, when, inWindow, sessionOf, ny, TIME_STOP, HISTORY, SYMBOL, TIMEFRAME };
if (require.main === module) {
  if (process.argv.includes('--test')) {
    if (!process.env.DISCORD_WEBHOOK_URL) { console.error('No DISCORD_WEBHOOK_URL in .env yet.'); process.exit(2); }
    discord('🧪 Silver watcher test', 'The silver trap watcher can post to this channel.', GREY).then(() => log('Test message sent'));
  } else {
    if (!process.env.DISCORD_WEBHOOK_URL) log('No Discord webhook in .env: alerts will only be printed here.');
    main().catch((e) => { console.error('Error:', e.message); process.exit(2); });
  }
}
