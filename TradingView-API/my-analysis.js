// Starter technical-analysis script. No TradingView login needed.
// Usage:  node my-analysis.js BINANCE:BTCUSDT 60
//         (symbol, timeframe: 1, 5, 15, 60, 240, D, W, M)
// Each run is saved to ../results/<symbol>_<timeframe>_<date>.json and .csv
const fs = require('fs');
const path = require('path');
const TradingView = require('./main');
const { sma, ema, rsi, macd } = require('./indicators');

const SYMBOL = process.argv[2] || 'BINANCE:BTCUSDT';
const TIMEFRAME = process.argv[3] || 'D';
const CANDLES = 300; // enough history for a 200-period moving average
const RESULTS_DIR = path.join(__dirname, '..', 'results');

// TradingView's rating, as returned by this library: -2 (strong sell) .. +2 (strong buy)
function ratingLabel(v) {
  if (v >= 1) return 'Strong buy';
  if (v >= 0.2) return 'Buy';
  if (v > -0.2) return 'Neutral';
  if (v > -1) return 'Sell';
  return 'Strong sell';
}

const round = (v, d = 2) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

// --- Fetch candles over the websocket, then disconnect ---

function getCandles(symbol, timeframe, range) {
  return new Promise((resolve, reject) => {
    const client = new TradingView.Client();
    const chart = new client.Session.Chart();
    const fail = (msg) => { client.end(); reject(new Error(msg)); };
    const timer = setTimeout(() => fail('Timed out waiting for candles'), 30000);

    chart.onError((...err) => { clearTimeout(timer); fail(err.join(' ')); });
    chart.onUpdate(() => {
      if (chart.periods.length < 2) return;
      clearTimeout(timer);
      const candles = [...chart.periods].reverse(); // oldest first
      const { description, currency_id: currency } = chart.infos;
      client.end();
      resolve({ candles, description, currency });
    });
    chart.setMarket(symbol, { timeframe, range });
  });
}

async function main() {
  const [ta, { candles, description, currency }] = await Promise.all([
    TradingView.getTA(SYMBOL),
    getCandles(SYMBOL, TIMEFRAME, CANDLES),
  ]);

  const closes = candles.map((c) => c.close);
  const ind = {
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    ema20: ema(closes, 20),
    rsi14: rsi(closes, 14),
    macd: macd(closes),
  };

  const rows = candles.map((c, i) => ({
    time: new Date(c.time * 1000).toISOString().slice(0, 16).replace('T', ' '),
    open: c.open,
    high: c.max,
    low: c.min,
    close: c.close,
    volume: round(c.volume, 0),
    sma20: round(ind.sma20[i]),
    sma50: round(ind.sma50[i]),
    sma200: round(ind.sma200[i]),
    ema20: round(ind.ema20[i]),
    rsi14: round(ind.rsi14[i]),
    macd: round(ind.macd.line[i]),
    macdSignal: round(ind.macd.signal[i]),
    macdHist: round(ind.macd.hist[i]),
  }));

  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];

  // Plain-language signals from the latest candle
  const signals = [];
  if (last.rsi14 >= 70) signals.push(`RSI ${last.rsi14}: overbought (>= 70)`);
  else if (last.rsi14 <= 30) signals.push(`RSI ${last.rsi14}: oversold (<= 30)`);
  else signals.push(`RSI ${last.rsi14}: neutral zone`);
  if (last.sma200 !== null) {
    signals.push(`Price is ${last.close > last.sma200 ? 'above' : 'below'} the 200 SMA (long-term ${last.close > last.sma200 ? 'uptrend' : 'downtrend'})`);
  }
  if (last.sma50 !== null && last.sma200 !== null) {
    const crossUp = prev.sma50 <= prev.sma200 && last.sma50 > last.sma200;
    const crossDown = prev.sma50 >= prev.sma200 && last.sma50 < last.sma200;
    if (crossUp) signals.push('Golden cross: 50 SMA just crossed above 200 SMA');
    if (crossDown) signals.push('Death cross: 50 SMA just crossed below 200 SMA');
  }
  if (prev.macdHist !== null) {
    if (prev.macdHist <= 0 && last.macdHist > 0) signals.push('MACD just crossed above its signal line (bullish)');
    else if (prev.macdHist >= 0 && last.macdHist < 0) signals.push('MACD just crossed below its signal line (bearish)');
    else signals.push(`MACD is ${last.macdHist > 0 ? 'above' : 'below'} its signal line (${last.macdHist > 0 ? 'bullish' : 'bearish'} momentum)`);
  }

  const rating = Object.fromEntries(Object.entries(ta || {}).map(([tf, r]) => [tf, {
    overall: ratingLabel(r.All), oscillators: ratingLabel(r.Other), movingAverages: ratingLabel(r.MA), ...r,
  }]));

  // --- Print ---
  const tfLabel = /^\d+$/.test(TIMEFRAME) ? `${TIMEFRAME}-minute` : { D: 'daily', W: 'weekly', M: 'monthly' }[TIMEFRAME] || TIMEFRAME;
  console.log(`\n=== ${description} (${SYMBOL}), ${tfLabel} candles, ${currency} ===`);
  console.log(`Last close: ${last.close} at ${last.time} UTC`);
  console.log('\n--- TradingView technical rating (-2 strong sell .. +2 strong buy) ---');
  console.table(rating);
  console.log('\n--- Latest 5 candles with indicators ---');
  console.table(rows.slice(-5));
  console.log('\n--- Signals ---');
  signals.forEach((s) => console.log(`* ${s}`));

  // --- Save ---
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const base = path.join(RESULTS_DIR, `${SYMBOL.replace(':', '_')}_${TIMEFRAME}_${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({
    symbol: SYMBOL, description, currency, timeframe: TIMEFRAME, generatedAt: new Date().toISOString(),
    rating, signals, candles: rows,
  }, null, 2));
  const header = Object.keys(rows[0]);
  fs.writeFileSync(`${base}.csv`, [header.join(','), ...rows.map((r) => header.map((h) => r[h] ?? '').join(','))].join('\n'));
  console.log(`\nSaved: results/${path.basename(base)}.json and .csv`);
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
