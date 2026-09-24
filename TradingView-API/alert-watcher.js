// Watches live TradingView prices and posts to Discord when a rule in ../alerts.js fires.
// Usage:  node alert-watcher.js          watch (prints to the console only if no webhook is set)
//         node alert-watcher.js --test   send one test message to Discord and exit
const path = require('path');
const TradingView = require('./main');
const { sma, rsi, macd } = require('./indicators');

const ROOT = path.join(__dirname, '..');
const CANDLES = 300; // enough history for the 200 SMA
const DEFAULT_COOLDOWN_MIN = 60;

try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env yet */ }
const WEBHOOK = (process.env.DISCORD_WEBHOOK_URL || '').trim();
const { makeDiscord, log, GREEN, RED, GREY } = require('./discord');
const discord = makeDiscord(WEBHOOK, 'TradingView Alerts');
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(2) : Number(v.toPrecision(6))).toLocaleString('en-US');

// --- Rules: each type is a condition on the latest values; it fires when it turns true ---

const RULES = {
  price_above: { needs: true, uses: ['close'], test: (d, v) => d.close > v, text: (d, v) => `Price ${fmt(d.close)} is above ${fmt(v)}`, color: GREEN },
  price_below: { needs: true, uses: ['close'], test: (d, v) => d.close < v, text: (d, v) => `Price ${fmt(d.close)} is below ${fmt(v)}`, color: RED },
  rsi_above: { needs: true, uses: ['rsi'], test: (d, v) => d.rsi > v, text: (d, v) => `RSI ${d.rsi.toFixed(1)} is above ${v}`, color: RED },
  rsi_below: { needs: true, uses: ['rsi'], test: (d, v) => d.rsi < v, text: (d, v) => `RSI ${d.rsi.toFixed(1)} is below ${v}`, color: GREEN },
  move_up_pct: { needs: true, uses: ['movePct'], test: (d, v) => d.movePct >= v, text: (d, v) => `Up ${d.movePct.toFixed(2)}% this candle (limit ${v}%), price ${fmt(d.close)}`, color: GREEN },
  move_down_pct: { needs: true, uses: ['movePct'], test: (d, v) => -d.movePct >= v, text: (d, v) => `Down ${(-d.movePct).toFixed(2)}% this candle (limit ${v}%), price ${fmt(d.close)}`, color: RED },
  golden_cross: { uses: ['sma50', 'sma200'], test: (d) => d.sma50 > d.sma200, text: (d) => `Golden cross: 50 SMA (${fmt(d.sma50)}) crossed above 200 SMA (${fmt(d.sma200)})`, color: GREEN },
  death_cross: { uses: ['sma50', 'sma200'], test: (d) => d.sma50 < d.sma200, text: (d) => `Death cross: 50 SMA (${fmt(d.sma50)}) crossed below 200 SMA (${fmt(d.sma200)})`, color: RED },
  macd_cross_up: { uses: ['macdHist'], test: (d) => d.macdHist > 0, text: (d) => `MACD crossed above its signal line (hist ${fmt(d.macdHist)})`, color: GREEN },
  macd_cross_down: { uses: ['macdHist'], test: (d) => d.macdHist < 0, text: (d) => `MACD crossed below its signal line (hist ${fmt(d.macdHist)})`, color: RED },
};

function loadRules() {
  const rules = require(path.join(ROOT, 'alerts.js'));
  rules.forEach((r, i) => {
    const where = `alerts.js rule #${i + 1}`;
    if (!r.symbol || !r.timeframe) throw new Error(`${where}: needs symbol and timeframe`);
    if (!RULES[r.type]) throw new Error(`${where}: unknown type "${r.type}". Valid: ${Object.keys(RULES).join(', ')}`);
    if (RULES[r.type].needs && typeof r.value !== 'number') throw new Error(`${where}: "${r.type}" needs a numeric value`);
  });
  return rules.map((r) => ({ ...r, state: null, lastFired: 0 }));
}

const describe = (r) => `${r.symbol} ${r.timeframe}: ${r.type}${r.value !== undefined ? ` ${r.value}` : ''}`;

// --- Watch ---

function snapshot(periods) {
  const candles = [...periods].reverse(); // oldest first
  const closes = candles.map((c) => c.close);
  const last = closes.length - 1;
  const m = macd(closes);
  return {
    close: closes[last],
    movePct: last > 0 ? ((closes[last] - closes[last - 1]) / closes[last - 1]) * 100 : 0,
    rsi: rsi(closes)[last],
    sma50: sma(closes, 50)[last],
    sma200: sma(closes, 200)[last],
    macdHist: m.hist[last],
  };
}

async function watch() {
  const rules = loadRules();
  if (!rules.length) throw new Error('alerts.js has no rules');

  const client = new TradingView.Client();
  let stopping = false;
  client.onDisconnected(() => {
    if (stopping) return;
    log('Disconnected from TradingView, exiting so the launcher restarts');
    process.exit(1);
  });
  client.onError((...err) => log('Client error:', ...err));

  const groups = {};
  rules.forEach((r) => { (groups[`${r.symbol}|${r.timeframe}`] ??= []).push(r); });

  const ready = new Set();
  const failed = new Set();
  const startupTrue = [];
  const announceIfAllLoaded = () => {
    if (ready.size + failed.size !== Object.keys(groups).length) return;
    discord(
      '✅ Alert watcher started',
      `Watching ${rules.filter((r) => ready.has(`${r.symbol}|${r.timeframe}`)).length} rules on ${ready.size} charts`
      + `${failed.size ? ` (${failed.size} failed to load)` : ''}.\n\n`
      + `**Already true right now** (won't alert until they turn false and back to true):\n${startupTrue.length ? startupTrue.join('\n') : 'none'}`,
      GREY,
    );
  };

  Object.entries(groups).forEach(([key, groupRules]) => {
    const [symbol, timeframe] = key.split('|');
    const chart = new client.Session.Chart();
    let reportedError = false;

    chart.onError((...err) => {
      if (reportedError) return;
      reportedError = true;
      if (!ready.has(key)) { failed.add(key); announceIfAllLoaded(); }
      log(`Chart error for ${symbol} ${timeframe}:`, ...err);
      discord(`⚠️ ${symbol} ${timeframe}`, `Could not load this market: ${err.join(' ')}\nCheck the symbol in alerts.js.`, GREY);
    });

    chart.onUpdate(() => {
      if (chart.periods.length < 2) return;
      const d = snapshot(chart.periods);
      const now = Date.now();

      groupRules.forEach((r) => {
        const rule = RULES[r.type];
        if (rule.uses.some((f) => d[f] === null || Number.isNaN(d[f]))) return; // not enough history yet
        const isTrue = rule.test(d, r.value);

        if (r.state === null) { // first reading: remember it, don't fire
          r.state = isTrue;
          if (isTrue) startupTrue.push(`• ${describe(r)} → ${rule.text(d, r.value)}`);
          return;
        }
        const cooldown = (r.cooldownMinutes ?? DEFAULT_COOLDOWN_MIN) * 60000;
        if (isTrue && !r.state && now - r.lastFired >= cooldown) {
          r.lastFired = now;
          log('ALERT', describe(r), '-', rule.text(d, r.value));
          discord(`🔔 ${chart.infos.description || symbol} (${symbol}, ${timeframe})`, rule.text(d, r.value), rule.color);
        }
        r.state = isTrue;
      });

      if (!ready.has(key)) {
        ready.add(key);
        log(`Watching ${symbol} ${timeframe} (${groupRules.length} rule${groupRules.length > 1 ? 's' : ''}), last price ${fmt(d.close)}`);
        announceIfAllLoaded();
      }
    });

    chart.setMarket(symbol, { timeframe, range: CANDLES });
  });

  const stop = () => { stopping = true; log('Stopping'); client.end(); discord('⏹️ Alert watcher stopped', 'You will not get alerts until it is started again.', GREY).then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv.includes('--test')) {
  if (!WEBHOOK) { console.error('No DISCORD_WEBHOOK_URL in .env yet.'); process.exit(2); }
  discord('🧪 Test message', 'Your TradingView alert watcher can post to this channel.', GREY).then(() => log('Test message sent'));
} else {
  if (!WEBHOOK) log('No Discord webhook in .env: alerts will only be printed here.');
  watch().catch((e) => { console.error('Error:', e.message); process.exit(2); });
}
