// Dip-buy bot for make.fun btc-race (bars-replay/v1).
//
// How the harness drives this bot:
//   - The hello message opens the session. It names the symbol universe
//     (CBBTC), the starting cash ($1,000 paper), the fee/slippage model and
//     the seed. Nothing is traded yet; hello only sets the table.
//   - After hello, the harness streams the replay in batches. Every batch
//     carries a run of 1-minute bars for CBBTC (open/high/low/close, in
//     quote units), each bar stamped with its sequence number.
//   - For every batch the bot answers with its orders for that moment: an
//     array that is usually empty, a buy order when it wants in, or a sell
//     order when it wants out. Orders are filled at the next bar's open
//     under the harness fill model (4 bps fee + 2 bps slippage +
//     constant-product impact); the bot never sees the future.
//   - The run is deterministic: the same bars always produce the same
//     orders, because the bot reads no network, no wall clock and no
//     randomness. The official grade runs the bot twice and requires the
//     two action logs to match byte for byte.
//
// Strategy -- three rules, deliberately simple (anti-overfit):
//   Entry (when flat): the close dips >= 0.8% below its 30-bar SMA, while
//     the 30-bar SMA is above the 120-bar SMA (uptrend filter). Filled at
//     next open.
//   Exit (when holding): take-profit at +1.2% of cost, OR stop-loss at
//     -1.2% of cost, OR time stop after 240 bars held.
//
// Long only, one position, full size ($1,000 paper).
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
//
// Race history (btc-race-24h-20261118-1444, opened 14:44 UTC 18 Nov 2026):
//   Dev grade on THIS race's kit (dev window 17 Nov 14:44 -> 18 Nov 14:44 UTC,
//   1,440 bars; falling window, buy-and-hold -$31.63): net PnL $0.00, 0 trades.
//   The uptrend filter (SMA-30 > SMA-120) never triggered, so the bot sent no
//   orders at all -- it cannot race and cannot win; this entry is dev-board only.
//   Refactored 18 Nov 2026 ~22:45 WIB in a post-opening session for
//   readability only (descriptive constant names, entry/exit split into named
//   helpers, this protocol documentation). No number, threshold or decision
//   rule changed; the dev grade is re-run after this refactor to confirm the
//   action log is byte-identical to the pre-refactor run.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- Trend windows (in bars) -----------------------------------------------
// The dip is measured against the fast average; the trend filter requires
// the fast average to sit above the slow average.
const SMA_FAST_PERIOD = 30;
const SMA_SLOW_PERIOD = 120;

// --- Entry -----------------------------------------------------------------
// Buy only when the latest close sits at least this far below the fast SMA.
const DIP_THRESHOLD = 0.008; // 0.8%

// --- Exits (exact integer ratios against cost) -----------------------------
const TAKE_PROFIT_NUM = 1012n; // +1.2%
const TAKE_PROFIT_DEN = 1000n;
const STOP_LOSS_NUM = 988n; // -1.2%
const STOP_LOSS_DEN = 1000n;

// --- Holding limit ---------------------------------------------------------
const MAX_HOLD_BARS = 240;

// --- Order limits ----------------------------------------------------------
const MAX_SLIPPAGE_BPS = 100;
const MIN_NOTIONAL = 1_000_000n; // $1 in quote units (1 unit = 0.000001 USDC)

const closes: number[] = [];
let entrySeq: number | null = null;
let lastQty = 0n;

// --- Helpers ---------------------------------------------------------------
// The three decision rules live here as small named functions, so onBatch
// below reads as the harness flow: absorb the batch's bars, then answer
// with orders. Every helper is pure arithmetic on the same numbers the
// original inline code used; no threshold or comparison changed.

// Simple moving average of the last `period` closes, or null while the
// history is shorter than the period. The sum runs oldest-to-newest, exactly
// as the original loop did, so the floating-point result is unchanged.
function sma(period: number): number | null {
  if (closes.length < period) return null;
  let s = 0;
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i];
  return s / period;
}

// Entry signal: the latest close dipped below the fast SMA by the threshold
// while the fast SMA still sits above the slow SMA (the uptrend filter).
function dipBuySignal(smaFast: number, smaSlow: number): boolean {
  const latestClose = closes[closes.length - 1];
  return latestClose < smaFast * (1 - DIP_THRESHOLD) && smaFast > smaSlow;
}

// Exit signal: the reason to sell now, or null to keep holding. Checked in
// the same order as before -- take-profit, then stop-loss, then the time
// stop. Every reason produces the same sell order, so the order of the
// checks cannot change the orders the bot sends.
function exitSignal(state: BarsState, qty: bigint): 'take-profit' | 'stop-loss' | 'time-stop' | null {
  const held = state.positions.get(SYMBOL)!;
  const value = state.value(SYMBOL, qty);
  const cost = held.cost;
  if (value * TAKE_PROFIT_DEN >= cost * TAKE_PROFIT_NUM) return 'take-profit';
  if (value * STOP_LOSS_DEN <= cost * STOP_LOSS_NUM) return 'stop-loss';
  if (entrySeq !== null && state.seq - entrySeq >= MAX_HOLD_BARS) return 'time-stop';
  return null;
}

// --- Harness loop ----------------------------------------------------------
// runBars drives the session: the hello message opens it, then the harness
// streams one batch after another, each batch a run of 1-minute bars. For
// every batch this callback answers with the bot's orders for that moment:
// an empty array most of the time, a buy order on an entry signal, or a
// sell order on an exit signal. Orders are filled at the next bar's open.
await runBars({
  onBatch(state: BarsState, batch) {
    // 1. Absorb the batch: record every CBBTC close, in bar order.
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    // 2. Warm-up batches carry no decisions. The harness still feeds bars
    //    so the SMAs can build up, but the bot answers with no orders.
    if (state.warmingUp) return [];

    // 3. Track the open position: note the bar sequence when a fill first
    //    appears, clear it when the position closes.
    const held = state.positions.get(SYMBOL);
    const qty = held?.qty ?? 0n;
    if (qty > 0n && lastQty === 0n) entrySeq = state.seq;
    if (qty === 0n) entrySeq = null;
    lastQty = qty;

    // 4. Holding: check the three exit rules; any hit sells everything.
    if (qty > 0n) {
      if (exitSignal(state, qty) !== null) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // 5. Flat: both SMAs must exist before the entry rule can be judged.
    const smaFast = sma(SMA_FAST_PERIOD);
    const smaSlow = sma(SMA_SLOW_PERIOD);
    if (smaFast === null || smaSlow === null) return [];
    if (dipBuySignal(smaFast, smaSlow)) {
      if (state.cash < MIN_NOTIONAL) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
