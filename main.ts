import { BPS, runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK = 60;
const ENTRY_BPS = 50n; // trailing 60-bar return must be >= +0.50%
const STOP_BPS = 400n; // exit when close <= highWater * (1 - 4%)
const COOLDOWN_BARS = 30;
const CASH_FRACTION_NUM = 98n;
const CASH_FRACTION_DEN = 100n;
const MAX_SLIPPAGE_BPS = 10_000;

interface SymbolTrack {
  closes: bigint[];
  highWater: bigint | null;
  exitSeq: number;
}

const tracks = new Map<string, SymbolTrack>();

function trackFor(symbol: string): SymbolTrack {
  let t = tracks.get(symbol);
  if (t === undefined) {
    t = { closes: [], highWater: null, exitSeq: -1 };
    tracks.set(symbol, t);
  }
  return t;
}

function trailingReturn(closes: bigint[]): bigint | null {
  if (closes.length <= LOOKBACK) return null;
  const latest = closes[closes.length - 1]!;
  const ref = closes[closes.length - 1 - LOOKBACK]!;
  return ref > 0n ? latest - ref : null;
}

function entryNotional(state: BarsState, symbol: string): bigint {
  const cashBudget = (state.cash * CASH_FRACTION_NUM) / CASH_FRACTION_DEN;
  const weightCap = state.weightRoom(symbol);
  const notional = cashBudget < weightCap ? cashBudget : weightCap;
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  return notional >= minNotional ? notional : 0n;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const warmingUp = state.warmingUp;

    for (const bar of batch.bars) {
      const symbol = bar.symbol;
      const track = trackFor(symbol);
      const close = BigInt(bar.c);
      track.closes.push(close);

      const position = state.positions.get(symbol);
      const holding = position !== undefined && position.qty > 0n;

      if (warmingUp) continue;

      if (holding) {
        if (track.highWater === null || close > track.highWater) track.highWater = close;
        const stopHit = track.highWater !== null && close * BPS <= track.highWater * (BPS - STOP_BPS);
        if (stopHit) {
          orders.push({ side: 'sell', symbol, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          track.highWater = null;
          track.exitSeq = state.seq;
        }
      } else {
        const cooledDown = state.seq - track.exitSeq >= COOLDOWN_BARS;
        const ret = trailingReturn(track.closes);
        const trendUp = ret !== null && ret * BPS >= (track.closes[track.closes.length - 1 - LOOKBACK]!) * ENTRY_BPS;
        if (cooledDown && trendUp) {
          const notional = entryNotional(state, symbol);
          if (notional > 0n) {
            orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
            track.highWater = close;
          }
        }
      }
    }

    return orders;
  },
});
