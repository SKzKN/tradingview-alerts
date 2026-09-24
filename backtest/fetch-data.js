// Downloads candles from TradingView and caches them in backtest/data/<SYMBOL>_<TF>.json
// Usage: node fetch-data.js                                   (default stock list)
//        node fetch-data.js --symbols BYBIT:BTCUSDT.P --tf 60,240,D
const fs = require('fs');
const path = require('path');
const TradingView = require('../TradingView-API/main');

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const SYMBOLS = arg('--symbols') ? arg('--symbols').split(',') : ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'NASDAQ:GOOGL', 'NASDAQ:AMZN', 'NASDAQ:META',
  'NASDAQ:NVDA', 'NASDAQ:TSLA', 'NASDAQ:IREN', 'NASDAQ:NBIS'];
const TIMEFRAMES = arg('--tf') ? arg('--tf').split(',') : ['60', '240', 'D'];
// NBIS (ex-Yandex) was halted Mar 2022 - Oct 2024; older bars are a different business.
const START = { 'NASDAQ:NBIS': Date.UTC(2024, 9, 21) / 1000 };
const OUT = path.join(__dirname, 'data');

function fetchBars(client, symbol, timeframe) {
  return new Promise((resolve, reject) => {
    const chart = new client.Session.Chart();
    let idle;
    const timeout = setTimeout(() => { chart.delete(); reject(new Error(`${symbol} ${timeframe}: timeout`)); }, 60000);
    chart.onError((...e) => { clearTimeout(timeout); chart.delete(); reject(new Error(`${symbol} ${timeframe}: ${e.join(' ')}`)); });
    chart.onUpdate(() => {
      clearTimeout(idle);
      idle = setTimeout(() => { // wait until the history stops arriving
        clearTimeout(timeout);
        const bars = [...chart.periods].reverse()
          .filter((p) => p.time >= (START[symbol] || 0))
          .map((p) => [p.time, p.open, p.max, p.min, p.close, p.volume]);
        chart.delete();
        resolve(bars);
      }, 4000);
    });
    chart.setMarket(symbol, { timeframe, range: 20000 });
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const client = new TradingView.Client();
  for (const symbol of SYMBOLS) {
    const results = await Promise.all(TIMEFRAMES.map((tf) => fetchBars(client, symbol, tf)));
    results.forEach((bars, i) => {
      const file = path.join(OUT, `${symbol.split(':')[1]}_${TIMEFRAMES[i]}.json`);
      fs.writeFileSync(file, JSON.stringify(bars));
      console.log(`${symbol} ${TIMEFRAMES[i]}: ${bars.length} bars, ${new Date(bars[0][0] * 1000).toISOString().slice(0, 10)} to ${new Date(bars[bars.length - 1][0] * 1000).toISOString().slice(0, 10)}`);
    });
  }
  client.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
