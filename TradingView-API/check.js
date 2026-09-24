// Stateless alert check, made for scheduled cloud runs: look at the candle(s) that just closed,
// post any new entry or exit to Discord, and exit. One run per candle close, no memory needed.
//   node check.js --rule silver-asia     silver 1H: Asia-session reclaim long   (run at :12 past the hour, 23:00-06:00 UTC)
//   node check.js --rule stocks-sfp      stocks 1H: swing-low SFP with buyer delta, target 3R (run at :32 past, 14:00-20:00 UTC)
//   node check.js --rule silver-comex    silver 30m: failed breakout above the COMEX opening range, short (run 13:42 and 14:12 UTC)
// Options: --lookback N (treat the last N closed candles as new, default 1), --dry (print, don't post)
const path = require('path');
const TradingView = require('./main');
const SW = require('./silver-watcher');

const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const RULE = arg('--rule');
const LOOKBACK = Number(arg('--lookback', 1));
const DRY = process.argv.includes('--dry');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* cloud: webhook comes from the environment */ }
const { makeDiscord, log, GREEN, RED, GREY, BLUE } = require('./discord');
const discord = makeDiscord(DRY ? '' : (process.env.DISCORD_WEBHOOK_URL || '').trim(), 'Trade Alerts');
const p = (v, d = 2) => v.toFixed(d);
const STOCKS = ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'NASDAQ:GOOGL', 'NASDAQ:AMZN', 'NASDAQ:META', 'NASDAQ:NVDA', 'NASDAQ:TSLA', 'NASDAQ:IREN', 'NASDAQ:NBIS'];

// ---------- data ----------
const client = new TradingView.Client();
let diagnosed = false;
async function diagnose() { // when the websocket fails: is it this network, or TradingView refusing us?
  if (diagnosed) return; diagnosed = true;
  const axios = require('axios');
  log('diagnostics: proxy env', JSON.stringify({ HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || '', HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || '', NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || '' }), 'node', process.version);
  for (const url of ['https://www.tradingview.com/', 'https://data.tradingview.com/', 'https://scanner.tradingview.com/global/scan', 'https://discord.com/api/']) {
    const r = await axios.get(url, { timeout: 10000, validateStatus: () => true, maxRedirects: 0 }).catch((e) => ({ status: 'ERR', statusText: e.code || e.message }));
    log(`diagnostics: GET ${url} -> ${r.status} ${r.statusText || ''}`.trim());
  }
}
client.onError((...e) => { log('client error', ...e); diagnose(); });
function loadCandles(symbol, timeframe, range) { // closed candles only, oldest first
  return new Promise((resolve, reject) => {
    const chart = new client.Session.Chart(); let idle;
    const timer = setTimeout(() => reject(new Error(`${symbol} ${timeframe}: timeout`)), 45000);
    chart.onError((...e) => { clearTimeout(timer); reject(new Error(`${symbol} ${timeframe}: ${e.join(' ')}`)); });
    chart.onUpdate(() => { clearTimeout(idle); idle = setTimeout(() => { clearTimeout(timer); const all = [...chart.periods].reverse().map((x) => ({ t: x.time, o: x.open, h: x.max, l: x.min, c: x.close, v: x.volume || 0 })); resolve({ chart, candles: all.slice(0, -1), live: all[all.length - 1] }); }, 2500); });
    chart.setMarket(symbol, { timeframe, range });
  });
}
function footprintDelta(chart, t) { // buy - sell volume of one candle, via the volume profile with up/down volume
  return new Promise((resolve) => {
    const vp = new TradingView.BuiltInIndicator('VbPFixed@tv-basicstudies-241!');
    vp.setOption('first_bar_time', t * 1000); vp.setOption('last_bar_time', t * 1000); vp.setOption('rows', 20);
    const s = new chart.Study(vp); const done = (v) => { clearTimeout(timer); try { s.remove(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => done(null), 15000);
    s.onError(() => done(null));
    s.onUpdate(() => { const h = s.graphic.horizHists; done({ buy: h.reduce((a, r) => a + r.rate[0], 0), sell: h.reduce((a, r) => a + r.rate[1], 0) }); });
  });
}
const atr14 = (c) => { let a = 0; for (let i = 1; i < c.length; i += 1) { const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); a = i <= 14 ? a + tr / 14 : (a * 13 + tr) / 14; c[i].atr = i >= 14 ? a : null; } };
const when = (t) => `${new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// follow a trade from its signal candle; return the exit events with the candle index they happened on
function resolve(c, sig, hold, targets) {
  const out = []; let hit1 = false;
  for (let j = sig.idx + 1; j < c.length && j <= sig.idx + hold; j += 1) {
    const b = c[j]; const d = sig.dir;
    if (d === 1 ? b.l <= sig.stop : b.h >= sig.stop) { out.push({ j, what: 'stopped', r: -1 }); return out; }
    if (targets[1] && (d === 1 ? b.h >= targets[1] : b.l <= targets[1])) { out.push({ j, what: 'final target', r: targets.rFinal }); return out; }
    if (!hit1 && targets[0] && (d === 1 ? b.h >= targets[0] : b.l <= targets[0])) { hit1 = true; out.push({ j, what: 'first target', r: targets.rFirst }); if (!targets[1]) return out; }
    if (j === sig.idx + hold) { out.push({ j, what: 'time stop', r: (d * (b.c - sig.entry)) / Math.abs(sig.entry - sig.stop) }); return out; }
  }
  return out;
}
function postExits(label, c, sigs, hold, mkTargets, n) {
  for (const s of sigs) {
    if (s.idx >= n - LOOKBACK) continue; // entered on a new candle: nothing to resolve yet
    for (const e of resolve(c, s, hold, mkTargets(s))) {
      if (e.j < n - LOOKBACK) continue; // happened before this run's candles: already reported
      const icon = e.what === 'stopped' ? '🛑' : e.what === 'time stop' ? '⏱️' : '🎯';
      discord(`${icon} ${label}: ${e.what}`, `Trade from ${when(s.t)} (entry ${p(s.entry, s.dp)}, stop ${p(s.stop, s.dp)}): ${e.what} at ${when(c[e.j].t)}, ${e.r >= 0 ? '+' : ''}${e.r.toFixed(2)}R`, e.r >= 0 ? GREEN : RED);
    }
  }
}

// ---------- rule: silver Asia-session reclaim (reuses the watcher's strategy) ----------
async function silverAsia() {
  const [{ candles: si, live }, { candles: dxy }, { candles: daily }] = await Promise.all([loadCandles(SW.SYMBOL, SW.TIMEFRAME, SW.HISTORY), loadCandles('TVC:DXY', '60', 400), loadCandles(SW.SYMBOL, 'D', 80)]);
  const sigs = []; const st = new SW.Strategy((s) => sigs.push(s));
  si.forEach((c, i) => { if (i === 60) st.armed = true; st.push(c); });
  const n = si.length; const inWin = sigs.filter((s) => s.inWindow);
  const dxyAt = new Map(dxy.map((x) => [x.t, x.c])); const closes = daily.map((x) => x.c); const trend = closes.length > 50 ? (closes[closes.length - 1] > closes.slice(-50).reduce((a, b) => a + b, 0) / 50 ? 1 : -1) : null;
  log(`silver-asia: ${n} closed candles, last closed ${when(si[n - 1].t)} close ${p(si[n - 1].c, 3)}, live ${p(live.c, 3)}; ${inWin.length} in-window signals in history, ${st.pending.length} pending breakdown(s)`);
  for (const s of inWin.filter((s) => s.idx >= n - LOOKBACK)) {
    const hours = Math.max(s.candles, 4); let a; for (let h = hours; h <= hours + 3 && a === undefined; h += 1) a = dxyAt.get(s.t - h * 3600); const b = dxyAt.get(s.t);
    discord(`🔔 Silver: ${s.type} in the Asia window`, SW.describe(s, { dxy: a && b ? b / a - 1 : null, dxyHours: hours, daily: trend }), GREEN);
  }
  postExits('Silver Asia trade', si, inWin.map((s) => ({ ...s, dir: 1, dp: 3 })), SW.TIME_STOP, (s) => ({ 0: s.t1, 1: s.t2, rFirst: 1, rFinal: 2 }), n);
}

// ---------- rule: stocks, swing-low SFP with buyer delta, target 3R ----------
const L = 5; const MAX_LEVEL_AGE = 300; const HOLD = 150;
function sfpSignals(c) { // long SFPs of unswept 5-candle swing lows, as in the backtest
  atr14(c); const sigs = []; const lows = [];
  for (let t = 2 * L; t < c.length; t += 1) {
    const i = t - L; let isLow = true;
    for (let k = i - L; k <= i + L; k += 1) { if (k === i) continue; if (k < i ? c[k].l <= c[i].l : c[k].l < c[i].l) { isLow = false; break; } }
    if (isLow) lows.push({ idx: i, price: c[i].l });
    const m = t + 1; if (m >= c.length) break; const bar = c[m];
    const swept = lows.filter((x) => bar.l < x.price); const lvl = swept.filter((x) => bar.c > x.price).sort((a, b) => a.price - b.price)[0];
    if (lvl && bar.atr) sigs.push({ idx: m, t: bar.t, level: lvl.price, entry: bar.c, stop: bar.l - 0.1 * bar.atr, dir: 1, dp: 2 });
    for (let k = lows.length - 1; k >= 0; k -= 1) if (bar.l < lows[k].price || m - lows[k].idx > MAX_LEVEL_AGE) lows.splice(k, 1);
  }
  return sigs;
}
async function stocksSfp() {
  for (const sym of STOCKS) {
    let data; try { data = await loadCandles(sym, '60', 400); } catch (e) { log(e.message); continue; }
    const { chart, candles: c } = data; const n = c.length; const sigs = sfpSignals(c);
    const recent = sigs.filter((s) => s.idx >= n - HOLD - LOOKBACK);
    for (const s of recent) { const fp = await footprintDelta(chart, s.t); s.delta = fp ? fp.buy - fp.sell : null; s.buyPct = fp ? (100 * fp.buy) / (fp.buy + fp.sell || 1) : null; }
    const trades = recent.filter((s) => s.delta !== null && s.delta > 0);
    const name = sym.split(':')[1];
    log(`${name}: ${n} candles, last closed ${when(c[n - 1].t)} close ${p(c[n - 1].c)}; SFPs in the last ${HOLD} candles: ${recent.length}, with buyer delta: ${trades.length}`);
    for (const s of recent.filter((s) => s.idx >= n - LOOKBACK)) {
      const risk = s.entry - s.stop;
      if (s.delta === null) { discord(`⚠️ ${name}: SFP, delta unavailable`, `Swing-low SFP at ${when(s.t)} (level ${p(s.level)}), but the buy/sell split could not be fetched. Rule not confirmed.`, GREY); continue; }
      if (s.delta <= 0) { log(`${name}: SFP at ${when(s.t)} but sellers won the candle (${p(s.buyPct, 0)}% buy): no trade`); continue; }
      discord(`🔔 ${name}: swing-low SFP, buyers won (${p(s.buyPct, 0)}% buy)`, [`Level ${p(s.level)} swept and reclaimed on the ${when(s.t)} candle.`, '', `**Entry** ${p(s.entry)} (candle close)`, `**Stop** ${p(s.stop)} (risk ${p(risk)} = ${p((100 * risk) / s.entry)}%)`, `**Target 3R** ${p(s.entry + 3 * risk)}   (1R ${p(s.entry + risk)}, 2R ${p(s.entry + 2 * risk)})`, `Time stop: ${HOLD} candles. Backtest: ~36% wins, about +0.3R per trade.`].join('\n'), BLUE);
    }
    postExits(`${name} SFP trade`, c, trades, HOLD, (s) => ({ 0: null, 1: s.entry + 3 * (s.entry - s.stop), rFirst: 1, rFinal: 3 }), n);
    chart.delete();
  }
}

// ---------- rule: silver, failed breakout above the COMEX opening range, short ----------
async function silverComex() {
  const { candles: c, live } = await loadCandles('COMEX:SI1!', '30', 1500);
  atr14(c); c.forEach((b) => { b.ny = SW.ny(b.t); });
  const sigs = []; const HOLD30 = 8;
  for (let i = 0; i < c.length; i += 1) {
    if (!(c[i].ny.hour === 8 && new Date(c[i].t * 1000).getUTCMinutes() === 0)) continue; // the 08:00-08:30 ET candle
    const orH = c[i].h; let broke = null;
    for (let j = i + 1; j <= i + 3 && j < c.length; j += 1) {
      if (broke === null) { if (c[j].c > orH && c[j - 1].c <= orH) broke = j; continue; }
      if (c[j].c < orH) { // failed within 45 minutes of the breakout
        const b = c[j]; if (!b.atr) break;
        const hi = Math.max(...c.slice(broke, j + 1).map((x) => x.h)); let stop = hi + 0.1 * b.atr; if (stop - b.c < 0.5 * b.atr) stop = b.c + 0.5 * b.atr;
        sigs.push({ idx: j, t: b.t, orHigh: orH, entry: b.c, stop, dir: -1, dp: 3, broke }); break;
      }
      if (j - broke >= 2) break;
    }
  }
  const n = c.length;
  log(`silver-comex: ${n} closed 30m candles, last closed ${when(c[n - 1].t)} close ${p(c[n - 1].c, 3)}, live ${p(live.c, 3)}; ${sigs.length} setups in history, last ${sigs.length ? when(sigs[sigs.length - 1].t) : 'none'}`);
  for (const s of sigs.filter((s) => s.idx >= n - LOOKBACK)) {
    const risk = s.stop - s.entry;
    discord('🔔 Silver: failed breakout above the COMEX opening range → short', [`08:00-08:30 ET range high ${p(s.orHigh, 3)}; broke above on the ${when(c[s.broke].t)} candle, closed back below on ${when(s.t)}.`, '', `**Entry** ${p(s.entry, 3)} (short at the close)`, `**Stop** ${p(s.stop, 3)} (risk ${p(risk, 3)} = ${p((100 * risk) / s.entry)}%; $${Math.round(risk * 1000)} per micro, $${Math.round(risk * 5000)} per full)`, `**1R** ${p(s.entry - risk, 3)}   **1.5R** ${p(s.entry - 1.5 * risk, 3)}   time stop: 4 hours`, '', '⚠️ 25-trade lead from 2026 (60% at 1R, +0.26R). The hourly version lost in the 2025 uptrend; the feed is 10 min delayed, check the live price.'].join('\n'), RED);
  }
  postExits('Silver COMEX short', c, sigs, HOLD30, (s) => ({ 0: s.entry - (s.stop - s.entry), 1: s.entry - 1.5 * (s.stop - s.entry), rFirst: 1, rFinal: 1.5 }), n);
}

// ---------- run ----------
(async () => {
  const rules = { 'silver-asia': silverAsia, 'stocks-sfp': stocksSfp, 'silver-comex': silverComex };
  if (!rules[RULE]) { console.error('Usage: node check.js --rule silver-asia|stocks-sfp|silver-comex [--lookback N] [--dry]'); process.exit(2); }
  if (!DRY && !process.env.DISCORD_WEBHOOK_URL) log('No DISCORD_WEBHOOK_URL set: printing instead of posting.');
  const timer = setTimeout(() => { log('Giving up after 4 minutes'); process.exit(1); }, 240000);
  try { await rules[RULE](); await discord.flush?.(); } catch (e) { console.error('Error:', e.message); client.end(); process.exit(1); }
  clearTimeout(timer); client.end(); setTimeout(() => process.exit(0), 1500);
})();
