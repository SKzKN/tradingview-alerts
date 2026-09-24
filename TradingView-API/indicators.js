// Indicators calculated locally from closing prices (oldest first).
// Shared by my-analysis.js and alert-watcher.js.

function sma(values, period) {
  return values.map((_, i) => (i < period - 1 ? null
    : values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period));
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  values.forEach((v, i) => {
    if (i < period - 1) out.push(null);
    else if (i === period - 1) out.push(values.slice(0, period).reduce((a, b) => a + b, 0) / period);
    else out.push(v * k + out[i - 1] * (1 - k));
  });
  return out;
}

// Wilder's RSI, same method TradingView uses
function rsi(values, period = 14) {
  const out = [null];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      out.push(i === period ? 100 - 100 / (1 + avgGain / avgLoss) : null);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out.push(100 - 100 / (1 + avgGain / avgLoss));
    }
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = values.map((_, i) => (slowEma[i] === null ? null : fastEma[i] - slowEma[i]));
  const start = line.findIndex((v) => v !== null);
  const sig = [...Array(start).fill(null), ...ema(line.slice(start), signal)];
  return { line, signal: sig, hist: line.map((v, i) => (sig[i] === null ? null : v - sig[i])) };
}

module.exports = { sma, ema, rsi, macd };
