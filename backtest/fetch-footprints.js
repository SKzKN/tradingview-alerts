// Fetches a per-price buy/sell volume split ("footprint") for single bars, using TradingView's
// fixed-range volume profile with Up/Down volume. Resumable: already-fetched bars are skipped.
// Usage: node fetch-footprints.js data/footprints/needed-<run>.json [--workers 4] [--rows 20]
// Output: data/footprints/<SYM>_<TF>.json = { "<bar time>": [[priceLow, priceHigh, buy, sell], ...] }
const fs = require('fs');
const path = require('path');
const TradingView = require('../TradingView-API/main');

const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const NEEDED = process.argv[2];
const WORKERS = Number(arg('--workers', 4));
const ROWS = Number(arg('--rows', 20));
const FP_DIR = path.join(__dirname, 'data', 'footprints');
const EXCHANGE = { 'BTCUSDT.P': 'BYBIT', 'SI1!': 'COMEX', 'GC1!': 'COMEX', DXY: 'TVC' }; // everything else is NASDAQ

if (!NEEDED) { console.error('Usage: node fetch-footprints.js <needed-file.json>'); process.exit(2); }

const store = {};
const fileOf = (sym, tf) => path.join(FP_DIR, `${sym}_${tf}.json`);
const load = (sym, tf) => { const k = `${sym}_${tf}`; if (!store[k]) store[k] = fs.existsSync(fileOf(sym, tf)) ? JSON.parse(fs.readFileSync(fileOf(sym, tf))) : {}; return store[k]; };
const save = () => Object.entries(store).forEach(([k, v]) => fs.writeFileSync(path.join(FP_DIR, `${k}.json`), JSON.stringify(v)));

const todo = JSON.parse(fs.readFileSync(NEEDED)).filter((x) => !(x.t in load(x.sym, x.tf)));
const bySeries = new Map();
todo.forEach((x) => { const k = `${x.sym}|${x.tf}`; if (!bySeries.has(k)) bySeries.set(k, []); bySeries.get(k).push(x); });
// split each series into chunks so several workers can share one symbol
const queue = [];
for (const [k, items] of bySeries) for (let i = 0; i < items.length; i += 300) queue.push([k, items.slice(i, i + 300)]);
console.log(`${todo.length} bars to fetch in ${bySeries.size} series (${queue.length} chunks) with ${WORKERS} workers`);

function fetchOne(chart, t) {
  return new Promise((resolve) => {
    const vp = new TradingView.BuiltInIndicator('VbPFixed@tv-basicstudies-241!');
    vp.setOption('first_bar_time', t * 1000);
    vp.setOption('last_bar_time', t * 1000);
    vp.setOption('rows', ROWS);
    const study = new chart.Study(vp);
    const done = (v) => { clearTimeout(timer); try { study.remove(); } catch { /* already gone */ } resolve(v); };
    const timer = setTimeout(() => done({ error: 'timeout' }), 20000);
    study.onError((...e) => done({ error: JSON.stringify(e[0]) }));
    study.onUpdate(() => done({ rows: study.graphic.horizHists.map((h) => [h.priceLow, h.priceHigh, h.rate[0], h.rate[1]]) }));
  });
}

let fetched = 0; let failed = 0;
const started = Date.now();

async function worker(client) {
  while (queue.length) {
    const [key, items] = queue.shift();
    const [sym, tf] = key.split('|');
    const chart = new client.Session.Chart();
    chart.setMarket(`${EXCHANGE[sym] || 'NASDAQ'}:${sym}`, { timeframe: tf, range: 10 });
    await new Promise((r) => chart.onSymbolLoaded(r));
    const out = load(sym, tf);
    for (const { t } of items) {
      const res = await fetchOne(chart, t);
      if (res.rows) { out[t] = res.rows; fetched += 1; } else { failed += 1; if (failed <= 5) console.log(`  ${sym} ${tf} ${t}: ${res.error}`); }
      if ((fetched + failed) % 100 === 0) {
        save();
        const rate = (fetched + failed) / ((Date.now() - started) / 1000);
        console.log(`  ${fetched + failed}/${todo.length} (${failed} failed), ${rate.toFixed(1)}/s, ~${Math.round((todo.length - fetched - failed) / rate / 60)} min left`);
      }
    }
    chart.delete();
  }
}

(async () => {
  fs.mkdirSync(FP_DIR, { recursive: true });
  const client = new TradingView.Client();
  await Promise.all(Array.from({ length: WORKERS }, () => worker(client)));
  save();
  client.end();
  console.log(`Done: ${fetched} fetched, ${failed} failed (re-run to retry failures).`);
})();
