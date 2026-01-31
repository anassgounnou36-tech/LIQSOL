# Example Logging Output with PR6 Final Fix

## Normal Cache Loading (Healthy Market)

When loading caches for a healthy Kamino market with 28 reserves:

```
[2026-01-30 16:15:00.000 +0000] INFO: Loading market caches (reserves + oracles)...
    market: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"

[2026-01-30 16:15:00.001 +0000] INFO: Loading reserves for market...
    market: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"

[2026-01-30 16:15:00.002 +0000] INFO: Fetching reserve pubkeys via getProgramAccounts...

[2026-01-30 16:15:02.345 +0000] INFO: Fetched reserve account pubkeys
    total: 28

[2026-01-30 16:15:03.456 +0000] DEBUG: Mapping reserve to liquidity mint
    reserve: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
    liquidityMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    marketPubkey: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"

[2026-01-30 16:15:03.457 +0000] DEBUG: Mapping reserve to liquidity mint
    reserve: "FRYBbRFXJ2fKJZ6q5jCQvK5c7cRZNP1jVcSPP6NEupXo"
    liquidityMint: "So11111111111111111111111111111111111111112"
    marketPubkey: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"

... (26 more reserves)

[2026-01-30 16:15:05.678 +0000] INFO: Reserve cache loaded successfully
    decoded: 28
    matchedMarket: 28
    cached: 28

[2026-01-30 16:15:06.789 +0000] INFO: Oracle cache loaded successfully
    pyth: 20
    switchboard: 8
    failed: 0
    cached: 28

[2026-01-30 16:15:06.790 +0000] INFO: Market caches loaded successfully
    market: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
    reserves: 28
    oracles: 28
    elapsedMs: 6790

[2026-01-30 16:15:06.791 +0000] INFO: Loaded reserve mints (showing first 10)
    mints: [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
      "So11111111111111111111111111111111111111112",   // SOL
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
      "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",  // stSOL
      "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",   // mSOL
      "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",  // ETH
      "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",  // WBTC
      "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",  // PYTH
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",  // BONK
      "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"   // jitoSOL
    ]
    total: 28

[2026-01-30 16:15:06.792 +0000] INFO: Loaded oracle mints (showing first 10)
    mints: [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
      "So11111111111111111111111111111111111111112",   // SOL
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
      "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",  // stSOL
      "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",   // mSOL
      "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",  // ETH
      "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",  // WBTC
      "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",  // PYTH
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",  // BONK
      "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"   // jitoSOL
    ]
    total: 28
```

---

## Warning: Small/Test Market (< 5 reserves)

When loading a test market with only 2 reserves:

```
[2026-01-30 16:20:00.000 +0000] INFO: Loading market caches (reserves + oracles)...
    market: "testMarket1234567890abcdefghijklmnopqrstuvwx"

[2026-01-30 16:20:00.001 +0000] INFO: Loading reserves for market...
    market: "testMarket1234567890abcdefghijklmnopqrstuvwx"

[2026-01-30 16:20:00.002 +0000] INFO: Fetching reserve pubkeys via getProgramAccounts...

[2026-01-30 16:20:01.234 +0000] INFO: Fetched reserve account pubkeys
    total: 2

[2026-01-30 16:20:01.500 +0000] INFO: Reserve cache loaded successfully
    decoded: 2
    matchedMarket: 2
    cached: 2

[2026-01-30 16:20:01.501 +0000] WARN: WARNING: Fewer reserves cached than expected
    cached: 2
    expected: 5
    message: "May indicate configuration issue, small market, or RPC problem"

[2026-01-30 16:20:02.000 +0000] INFO: Oracle cache loaded successfully
    pyth: 2
    switchboard: 0
    failed: 0
    cached: 2

[2026-01-30 16:20:02.001 +0000] WARN: WARNING: Fewer reserves than expected loaded
    market: "testMarket1234567890abcdefghijklmnopqrstuvwx"
    reserveCount: 2
    minExpected: 5
    message: "This may indicate a configuration issue or RPC problem"

[2026-01-30 16:20:02.002 +0000] INFO: Market caches loaded successfully
    market: "testMarket1234567890abcdefghijklmnopqrstuvwx"
    reserves: 2
    oracles: 2
    elapsedMs: 2002

[2026-01-30 16:20:02.003 +0000] INFO: Loaded reserve mints (showing first 10)
    mints: [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
      "So11111111111111111111111111111111111111112"   // SOL
    ]
    total: 2

[2026-01-30 16:20:02.004 +0000] INFO: Loaded oracle mints (showing first 10)
    mints: [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
      "So11111111111111111111111111111111111111112"   // SOL
    ]
    total: 2
```

---

## Future PR7+: Processing Obligations with Cache

When scoring obligations in PR7+, with proper error handling:

```
[2026-01-30 16:25:00.000 +0000] INFO: Starting liquidation scoring
    obligations: 1234

[2026-01-30 16:25:00.100 +0000] DEBUG: Scoring obligation
    obligation: "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo"
    deposits: 2
    borrows: 1

[2026-01-30 16:25:00.101 +0000] DEBUG: Processing deposit
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    amount: "1000000000"
    
[2026-01-30 16:25:00.102 +0000] DEBUG: Processing deposit
    mint: "So11111111111111111111111111111111111111112"
    amount: "5000000000"

[2026-01-30 16:25:00.103 +0000] WARN: Skipping obligation: No reserve for mint
    mint: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"  // Native SOL wrapped
    obligation: "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo"
    
[2026-01-30 16:25:00.200 +0000] INFO: Liquidation scoring complete
    totalObligations: 1234
    scored: 1198
    skipped: 36
    liquidatable: 23
```

---

## Benefits of Enhanced Logging

1. **Visibility**: Can see which mints are loaded at startup
2. **Debugging**: Can identify missing reserves/oracles immediately
3. **Validation**: Warns if cache size is suspiciously small
4. **Mapping Verification**: DEBUG logs show exact mint→reserve relationships
5. **Production Safety**: Graceful degradation when mints are missing

---

## Quick Checklist

✅ Cache loading shows reserve count  
✅ Cache loading shows oracle count  
✅ First 10 mints are logged for verification  
✅ Warnings appear if < 5 reserves loaded  
✅ DEBUG logs show mint mapping during decode  
✅ Future PR7+ code will handle missing entries gracefully  
