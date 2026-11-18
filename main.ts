// Dip-buy cbBTC bot for the 24h BTC race (btc-race-24h-20261118-1444).
//
// The idea in one line: buy a dip below the EMA-13, with no trend filter,
// then sell on take-profit, stop-loss, or a 480-bar time stop.
//
// Why no trend filter: in this race's dev window the price fell most of the
// day, so every trend filter (SMA-30/120, EMA-13/21) stayed red exactly
// while the price was dipping, and turned green only once the price had
// already bounced back too close to the EMA to trigger a buy. Both filtered
// variants scored $0.00 with 0 trades. Dropping the filter is what lets
// this bot trade at all — it buys the dip itself, not the trend.
//
// How the harness drives this bot (bars-replay/v1):
//   - The hello message opens the session. It names the symbol universe
//     (CBBTC), the starting cash ($1,000 paper), the fee/slippage model
//     (4 bps fee + 2 bps slippage + constant-product impact) and the seed.
//     Nothing is traded yet; hello only sets the table.
//   - After hello, the harness streams the replay in batches. Every batch
//     carries a run of 1-minute bars for CBBTC (open/high/low/close, in
//     quote units), each bar stamped with its sequence number.
//   - For every batch the bot answers with its orders for that moment: an
//     array that is usually empty, a buy order when the dip signal fires,
//     or a sell order when an exit fires. Orders fill at the next bar's
//     open under the harness fill model; the bot never sees the future.
//   - The run is deterministic: the same bars always produce the same
//     orders, because the bot reads no network, no wall clock and no
//     randomness. The official grade runs the bot twice and requires the
//     two action logs to match byte for byte.
//
// Dev grade on THIS race's kit (dev window 17 Nov 14:44 -> 18 Nov 14:44 UTC,
// 1,440 bars; falling window, buy-and-hold -$31.63):
//   net PnL +$10.447012, 2 trades, 1 round trip, guardrails met — PASSES
//   the dev gate (PnL > $0), so this entry RACES.
//   The trade: decide bar 65 -> fill bar 66 -> TP hit at bar 407,
//   +$10.45, held 341 bars, max drawdown $15.11.
//   Honest note: this rides ONE bounce inside this one frozen dev window,
//   not a demonstrated general edge. The race window is a different 24h
//   of live prices — past dev profit does not predict it. Enter because
//   entry is free and the gate is passed, not because the model is proven.
//
// Design notes (why the code is shaped this way):
//   - EMA seed: the EMA needs a starting value, so the first 13 closes
//     are averaged into a plain SMA seed. That is the only place the bot
//     looks back more than one bar, and it uses only bars from this very
//     window — nothing is carried in from before the replay starts.
//   - Exact exit ratios: take-profit and stop-loss compare the position's
//     current value against its cost basis as exact bigint ratios
//     (1012/1000 and 992/1000), never as floats, so a fill a fraction of
//     a cent from the line cannot flip the decision by rounding.
//   - One position, full size: the bot holds at most one position and
//     buys with all its cash. There is no partial sizing and no second
//     entry while flat logic would allow one — after a sell the dip signal
//     must fire again before any new buy, so the bot cannot re-enter on
//     the same bar it just exited.
//   - Warmup: while the harness is still warming up, onBatch returns no
//     orders at all, even if a dip is already visible. The bars are still
//     ingested (the EMA keeps up), but no trade is placed on them.
//   - Entry timing: the entry bar is marked on the first batch where the
//     held quantity goes from zero to positive — that is the batch after
//     the buy filled at the next bar's open — so the 480-bar time stop
//     counts from the fill, not from the decision bar.

import { BPS, runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- Strategy parameters ---------------------------------------------------
// Fixed for the whole run; the bot never adapts them mid-race.
const EMA_PERIOD = 13; // EMA length, in 1-minute bars
const DIP_THRESHOLD = 0.008; // buy when close is 0.8% below the EMA

// Exits as exact integer ratios against the position's cost basis, so the
// comparisons below are exact bigint arithmetic, never float rounding.
const TAKE_PROFIT_NUMERATOR = 1012n; // +1.2% over cost
const TAKE_PROFIT_DENOMINATOR = 1000n;
const STOP_LOSS_NUMERATOR = 992n; // -0.8% under cost
const STOP_LOSS_DENOMINATOR = 1000n;

// --- Holding and order limits ----------------------------------------------
const MAX_HOLD_BARS = 480; // time stop, counted in bars since entry
const MAX_SLIPPAGE_BPS = 100;
const MIN_ORDER_NOTIONAL = 1_000_000n; // $1 in quote units (1 unit = 0.000001 USDC)

// --- Run state -------------------------------------------------------------
// Everything below is rebuilt from the replayed bars; nothing is carried
// in from outside the window, so the run is fully deterministic.
const closeHistory: number[] = [];
let ema: number | null = null; // EMA-13 once seeded, null before bar 13
const seedCloses: number[] = []; // first 13 closes, averaged into the seed
let entrySeq: number | null = null; // sequence number of the bar where the position opened
let previousQty = 0n; // position size seen on the previous batch

// Advance the EMA-13 with one new close. Before the 13th close we only
// collect closes; on the 13th the seed is their plain average, and from
// then on the standard recursion with k = 2 / (13 + 1) applies. Causal:
// the EMA at any bar uses only closes up to that bar.
function advanceEma(close: number): void {
  if (ema !== null) {
    ema += (2 / (EMA_PERIOD + 1)) * (close - ema);
    return;
  }
  seedCloses.push(close);
  if (seedCloses.length === EMA_PERIOD) {
    let total = 0;
    for (const seedClose of seedCloses) total += seedClose;
    ema = total / EMA_PERIOD;
  }
}

// Record one batch of bars: keep every CBBTC close and feed it to the EMA.
// Bars for other symbols (none in this race) are ignored.
function ingestBatch(batch: Batch): void {
  for (const bar of batch.bars) {
    if (bar.symbol !== SYMBOL) continue;
    const close = Number(bar.c);
    closeHistory.push(close);
    advanceEma(close);
  }
}

// Buy signal: the latest close sits at least 0.8% below the EMA-13.
// Deliberately no trend filter — see the header for why.
function isDipBelowEma(): boolean {
  if (ema === null) return false;
  const latestClose = closeHistory[closeHistory.length - 1];
  return latestClose < ema * (1 - DIP_THRESHOLD);
}

// Exit reason for a held position, checked in priority order: take-profit
// first, then stop-loss, then the time stop.
function exitReason(state: BarsState, qty: bigint): 'take-profit' | 'stop-loss' | 'time-stop' | null {
  const held = state.positions.get(SYMBOL)!;
  const value = state.value(SYMBOL, qty);
  const cost = held.cost;
  if (value * TAKE_PROFIT_DENOMINATOR >= cost * TAKE_PROFIT_NUMERATOR) return 'take-profit';
  if (value * STOP_LOSS_DENOMINATOR <= cost * STOP_LOSS_NUMERATOR) return 'stop-loss';
  if (entrySeq !== null && state.seq - entrySeq >= MAX_HOLD_BARS) return 'time-stop';
  return null;
}

// Remember when the current position opened: the first batch where the
// held quantity goes from zero to positive marks the entry bar, which the
// time stop counts from. A flat book clears the marker.
function updateEntryTracking(state: BarsState, qty: bigint): void {
  if (qty > 0n && previousQty === 0n) entrySeq = state.seq;
  if (qty === 0n) entrySeq = null;
  previousQty = qty;
}

// --- Harness loop ----------------------------------------------------------
await runBars({
  onBatch(state: BarsState, batch) {
    ingestBatch(batch);
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const qty = held?.qty ?? 0n;
    updateEntryTracking(state, qty);

    if (qty > 0n) {
      if (exitReason(state, qty) !== null) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    if (isDipBelowEma()) {
      if (state.cash < MIN_ORDER_NOTIONAL) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
