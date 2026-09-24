// Your alert rules. Edit this list, then restart the watcher (./watch-alerts).
//
// Each rule needs: symbol, timeframe, type (and value for some types).
//   symbol     e.g. 'BINANCE:BTCUSDT', 'NASDAQ:AAPL', 'FX:EURUSD'  (same names as on TradingView)
//   timeframe  '1', '5', '15', '60', '240', 'D', 'W'
//
// Types:
//   price_above / price_below      value = price level
//   rsi_above / rsi_below          value = RSI level (14-period RSI)
//   move_up_pct / move_down_pct    value = % move of the current candle vs. the previous close
//   golden_cross / death_cross     50 SMA crosses above / below 200 SMA
//   macd_cross_up / macd_cross_down  MACD line crosses above / below its signal line
//
// An alert fires when its condition turns from false to true. After firing it
// waits `cooldownMinutes` (default 60) before it can fire again, so a price
// wobbling around a level doesn't flood your Discord.

module.exports = [
  { symbol: 'BINANCE:BTCUSDT', timeframe: '60', type: 'price_below', value: 80000 },
  { symbol: 'BINANCE:BTCUSDT', timeframe: '60', type: 'price_above', value: 90000 },
  { symbol: 'BINANCE:BTCUSDT', timeframe: '60', type: 'macd_cross_down' },
  { symbol: 'BINANCE:ETHUSDT', timeframe: 'D', type: 'rsi_above', value: 70 },
  { symbol: 'BINANCE:ETHUSDT', timeframe: 'D', type: 'rsi_below', value: 30 },
  { symbol: 'BINANCE:ETHUSDT', timeframe: '60', type: 'move_down_pct', value: 3 },
  { symbol: 'NASDAQ:AAPL', timeframe: 'D', type: 'death_cross' },
  { symbol: 'NASDAQ:AAPL', timeframe: 'D', type: 'price_below', value: 320 },
];
