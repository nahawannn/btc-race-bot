// Dip-buy bot for make.fun btc-race (bars-replay/v1).
//
// Three rules, deliberately simple (anti-overfit):
//
//   Entry (when flat): the close dips >= 0.8% below its 30-bar SMA, while the
//   30-bar SMA is above the 120-bar SMA (uptrend filter). Filled at next open.
//   Exit (when holding): take-profit at +1.2% of cost, OR stop-loss at -1.2%
//   of cost, OR time stop after 240 bars held.
//
// Long only, one position, full size ($1,000 paper). No network, no clock,
// no randomness: the same bars give the same orders, run after run.
//
// Backtest (honest): 117 rolling 24h windows of BTC 1m bars, 2026-10-19..11-18
// (Coinbase, exact harness fill math incl. 4 bps fee + 2 bps slippage +
// constant-product impact; simulator validated byte-exact vs grade-local on
// the ema-cross baseline: 68/68 orders identical, PnL -$106.21 = official):
//   mean PnL -$0.31 / window, median $0.00, win rate 2.6%, beats
//   buy-and-hold in 72.6% of windows (mean excess +$11.05) -- but that is
//   almost entirely "sits in cash while BTC falls": in the 31 up windows it
//   beats buy-and-hold 0% of the time (mean -$0.06 vs B&H +$10.18).
//   NO positive expected PnL was found for any 2-3 rule variant tested
//   (12 dip variants, EMA trend-follow, buy-and-hold, ema-cross baseline).
//   Dev window (frozen 2026-11-16/17): +$4.32, 1 round trip -- passes the
//   dev gate (PnL > $0) on that one window only. This bot is a free
//   lottery ticket for a down/sideways race window, NOT a demonstrated edge.
//   Do not expect it to win; enter only because entry is free.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST = 30;
const SLOW = 120;
const DIP = 0.008;
const TP_NUM = 1012n;
const TP_DEN = 1000n;
const SL_NUM = 988n;
const SL_DEN = 1000n;
const MAX_HOLD = 240;
const MAX_SLIPPAGE_BPS = 100;
const MIN_NOTIONAL = 1_000_000n;

const closes: number[] = [];
let entrySeq: number | null = null;
let lastQty = 0n;

function sma(n: number): number | null {
  if (closes.length < n) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    if (state.warmingUp) return [];
    const held = state.positions.get(SYMBOL);
    const qty = held?.qty ?? 0n;
    if (qty > 0n && lastQty === 0n) entrySeq = state.seq;
    if (qty === 0n) entrySeq = null;
    lastQty = qty;
    if (qty > 0n) {
      const value = state.value(SYMBOL, qty);
      const cost = held!.cost;
      if (value * TP_DEN >= cost * TP_NUM) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      if (value * SL_DEN <= cost * SL_NUM) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      if (entrySeq !== null && state.seq - entrySeq >= MAX_HOLD) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }
    const smaF = sma(FAST);
    const smaS = sma(SLOW);
    if (smaF === null || smaS === null) return [];
    if (closes[closes.length - 1] < smaF * (1 - DIP) && smaF > smaS) {
      if (state.cash < MIN_NOTIONAL) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
