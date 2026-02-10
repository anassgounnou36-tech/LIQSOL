# Presubmitter Cache

The presubmitter provides an in-memory cache of ready-to-send transactions for top liquidation candidates.

## Features

- **Bundle-ready transactions**: Prebuilt `VersionedTransaction` objects that can be broadcast immediately
- **Smart caching**: Tracks blockhash staleness and TTL to ensure freshness
- **Throttled refresh**: Prevents excessive rebuilding with configurable refresh intervals
- **Deterministic sizing**: Uses account-delta estimation (no log parsing) for swap sizing

## Configuration

Environment variables (see `.env.example`):

```bash
# Number of top plans to prebuild (default: 10)
PRESUBMIT_TOP_K=10

# Minimum refresh interval per obligation in ms (default: 3000)
PRESUBMIT_REFRESH_MS=3000

# Maximum age of cached transactions in ms (default: 60000)
PRESUBMIT_TTL_MS=60000
```

## Usage

### Basic Usage

```typescript
import { Presubmitter } from '../src/presubmit/presubmitter.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

// Setup
const connection = new Connection(rpcUrl);
const signer = Keypair.fromSecretKey(/* ... */);
const market = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const programId = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

const presubmitter = new Presubmitter({
  connection,
  signer,
  market,
  programId,
  topK: Number(process.env.PRESUBMIT_TOP_K ?? 10),
  refreshMs: Number(process.env.PRESUBMIT_REFRESH_MS ?? 3000),
});

// Prebuild top K plans
const plans = loadPlansFromQueue(); // Your plan loading logic
await presubmitter.prebuildTopK(plans);

// Get or build transaction for a specific plan
const entry = await presubmitter.getOrBuild(plan);

// Use cached transaction if fresh
const bh = await connection.getLatestBlockhash();
if (presubmitter.cache.isFresh(plan.obligationPubkey, bh.blockhash)) {
  const entry = presubmitter.cache.get(plan.obligationPubkey);
  if (entry) {
    // Broadcast entry.tx immediately
    await connection.sendRawTransaction(entry.tx.serialize());
  }
}

// Evict stale entries
const evicted = presubmitter.evictStale(bh.blockhash);
console.log(`Evicted ${evicted} stale entries`);
```

### Integration with Scheduler

For continuous operation, integrate the presubmitter into your scheduler loop:

```typescript
// In scheduler loop
const presubmitter = new Presubmitter(config);

setInterval(async () => {
  // Load fresh plans from tx_queue
  const plans = loadPlans();
  
  // Prebuild top K
  await presubmitter.prebuildTopK(plans);
  
  // Evict stale entries
  const bh = await connection.getLatestBlockhash();
  presubmitter.evictStale(bh.blockhash);
  
  // Stats
  const stats = presubmitter.stats();
  console.log(`[Presubmit] Cache: ${stats.size} entries`);
}, PRESUBMIT_REFRESH_MS);
```

### Cache Entry Structure

```typescript
export type PresubmitEntry = {
  tx: VersionedTransaction;        // Ready-to-send transaction
  builtAt: number;                  // Timestamp in ms
  lastSimSlot?: number;            // Slot from simulation
  expectedSeized?: bigint;         // Expected seized collateral (base units)
  expectedOut?: bigint;            // Expected swap output (base units)
  ev?: number;                     // Expected value
  ttl?: number;                    // Time to liquidation
  blockhash: string;               // Blockhash used
};
```

## How It Works

1. **Prebuild Phase**: For each top-K plan:
   - Build pre-sim transaction (ComputeBudget + FlashBorrow + Refresh + Liquidation)
   - Simulate to estimate seized collateral using account-delta approach
   - Apply safety haircut (SWAP_IN_HAIRCUT_BPS)
   - Build Jupiter swap with base-units API (if needed)
   - Assemble final transaction (+ FlashRepay)
   - Cache the ready-to-send `VersionedTransaction`

2. **Cache Management**:
   - Tracks blockhash for each entry
   - Evicts stale entries when blockhash changes
   - Respects TTL for maximum age
   - Throttles rebuilds per obligation (PRESUBMIT_REFRESH_MS)

3. **Broadcast**:
   - Check cache freshness before broadcast
   - If fresh: use cached transaction directly
   - If stale: rebuild before sending

## Benefits

- **Reduced latency**: Transactions are pre-built and ready to send
- **Deterministic**: Uses account-delta estimation (no log parsing)
- **Safe**: Safety haircut prevents oversizing swaps
- **Efficient**: Throttled refresh prevents excessive RPC calls
- **Bundle-compatible**: Ready-to-send transactions can be included in Jito bundles

## Notes

- Presubmitter is **optional** - executor works fine without it
- Default mode is **dry-run** (simulate only)
- Broadcasting requires explicit `--broadcast` flag
- Cached transactions are **in-memory only** (not persisted)
- Blockhash expiration (~150 slots) limits cache lifetime
