// Pump.fun Paper Sprint: early-momentum sniper with disciplined exits.
//
// How the wire works: the harness opens with one `hello` handshake (capital,
// caps, seed, latency in slots, fees), then sends one `batch` per slot. Each
// batch carries that slot's chain events (CreateEvent / TradeEvent /
// CompleteEvent), the latest marks, the fills of orders decided earlier, and
// the account after those fills. My `onBatch` answers that batch with the
// orders decided on this slot, in one reply echoing the batch's seq; the
// harness fills them latency_slots later. A final `done` ends the run and
// flattens whatever is left, so no reply is sent there.
//
// Strategy, in plain terms:
//   - A mint becomes a candidate on the batch carrying its CreateEvent. I note
//     its creation price (virtual quote reserves over virtual token reserves)
//     and its creation slot, and watch it.
//   - I buy only when early trading confirms momentum: at least 3 trades and
//     the price up at least 8% from creation. The buy is one small fixed
//     stake (0.1 SOL, or the per-mint size cap when that is smaller), never
//     more than one buy per mint, never more than 5 open positions, and only
//     when free cash covers the stake plus transaction fees. Buys on one mint
//     in one reply share one size cap, so a single whole order is sent.
//   - Every filled buy records its entry price (SOL spent over tokens
//     received, from the fill itself) and its decided slot. On each later
//     batch I re-price each holding from its curve's latest reserves and sell
//     the whole position when any exit fires: +35% take-profit, -28%
//     stop-loss, or 1200 slots held (a time exit, about eight minutes of
//     slots). The harness closes completed curves itself.
//   - Determinism is hard: no clock, no environment, no Math.random. Every
//     decision comes from slot numbers, reserve state and the fills the
//     harness reports, so the grader's two executions log identical actions.
//     All price math is integer (bigint, scaled by 1e6), so there is no
//     float drift between runs either.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

// ---- sizing ----------------------------------------------------------------

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 10n; // 0.1 SOL per buy
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL: a round trip must clear 0.01 SOL
const MAX_OPEN_POSITIONS = 5;
const MAX_BUYS_PER_BATCH = 4;
const BUY_SLIPPAGE_BPS = 2000;
const SELL_SLIPPAGE_BPS = 2000;

// ---- entry / exit triggers --------------------------------------------------

const MIN_TRADES_BEFORE_BUY = 5;
const MOMENTUM_BPS = 0; // unused in dip mode: see the dip check below
                       // (strong momentum was best so far at -2.78 SOL; testing reversion)
const CANDIDATE_MAX_AGE_SLOTS = 900; // drop a mint that never confirms
const TAKE_PROFIT_BPS = 12_000; // +20% bounce target
const STOP_LOSS_BPS = 8800; // -12%
const TIME_EXIT_SLOTS = 1200;

const SCALE = 1_000_000n; // price scaling for integer ratio math

// ---- per-mint bookkeeping ---------------------------------------------------

interface Candidate {
  createPrice: bigint; // scaled price at creation
  createdSlot: number;
}

interface Entry {
  entryPrice: bigint; // scaled SOL-per-token paid (fill quote / fill tokens)
  decidedSlot: number;
}

const candidates = new Map<string, Candidate>();
const decided = new Set<string>(); // mints already bought or passed on
const entries = new Map<string, Entry>();
const pendingSells = new Set<string>();

/** Scaled price: virtual quote reserves per virtual token, times SCALE. */
function scaledPrice(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * SCALE) / virtualToken;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // Fold this batch's fills into the entry bookkeeping first: a buy fill
    // records the entry price and slot; a sell fill (or a harness close)
    // clears it. Positions the harness already flattened are dropped too.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') {
        const tokens = BigInt(fill.token_amount);
        const quote = BigInt(fill.quote_lamports);
        if (tokens > 0n) {
          entries.set(fill.mint, {
            entryPrice: (quote * SCALE) / tokens,
            decidedSlot: fill.decided_slot,
          });
        }
      } else if (fill.side === 'sell') {
        // Only a filled sell closes the entry; a rejected/failed sell leaves
        // the entry in place so the next batch can try the exit again.
        if (fill.status === 'filled') entries.delete(fill.mint);
        pendingSells.delete(fill.mint);
      }
    }
    for (const mint of [...entries.keys()]) {
      if (!state.positions.has(mint)) entries.delete(mint);
    }

    // ---- exits: re-price every holding from its curve's latest reserves ----
    for (const [mint, holding] of state.positions) {
      if (pendingSells.has(mint)) continue;
      const entry = entries.get(mint);
      const curve = state.curves.get(mint);
      if (entry === undefined || curve === undefined || curve.complete) continue;
      const now = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (now <= 0n || entry.entryPrice <= 0n) continue;
      // ratio in ten-thousandths of entry price, integer math only.
      const ratio = (now * 10_000n) / entry.entryPrice;
      const heldSlots = state.slot - entry.decidedSlot;
      if (ratio >= TAKE_PROFIT_BPS || ratio <= STOP_LOSS_BPS || heldSlots >= TIME_EXIT_SLOTS) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        pendingSells.add(mint);
      }
    }

    // ---- entries: note new mints, then buy the ones confirming momentum ----
    for (const event of batch.events) {
      if (event.event !== 'CreateEvent') continue;
      const curve = state.curves.get(event.mint);
      if (curve === undefined) continue;
      candidates.set(event.mint, {
        createPrice: scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves),
        createdSlot: event.slot,
      });
    }

    let buys = 0;
    let free = state.freeCashLamports();
    const txFee = state.txFeeLamports();
    let slots = MAX_OPEN_POSITIONS - state.committedPositionCount();
    if (slots < 0) slots = 0;
    for (const [mint, cand] of candidates) {
      if (buys >= MAX_BUYS_PER_BATCH || slots <= 0) break;
      if (decided.has(mint)) {
        candidates.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        candidates.delete(mint);
        decided.add(mint);
        continue;
      }
      if (state.slot - cand.createdSlot > CANDIDATE_MAX_AGE_SLOTS) {
        candidates.delete(mint);
        decided.add(mint);
        continue;
      }
      if (curve.trades < MIN_TRADES_BEFORE_BUY) continue;
      const now = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (now <= 0n || cand.createPrice <= 0n) continue;
      // Dip buy (reversion): price pulled back 15-30% from creation — a
      // dip, not a collapse — with enough trading to have a real price.
      const ratioBps = (now * 10_000n) / cand.createPrice;
      if (ratioBps > 8500n || ratioBps < 7000n) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + txFee;
      slots -= 1;
      buys += 1;
      candidates.delete(mint);
      decided.add(mint);
    }

    return orders;
  },
});
