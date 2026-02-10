import { Connection, PublicKey, VersionedTransaction, TransactionMessage, Keypair } from '@solana/web3.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';

/**
 * Presubmit cache entry for a ready-to-send transaction
 */
export type PresubmitEntry = {
  tx: VersionedTransaction;
  builtAt: number; // timestamp in ms
  lastSimSlot?: number;
  expectedSeized?: bigint;
  expectedOut?: bigint;
  ev?: number;
  ttl?: number;
  blockhash: string;
};

/**
 * In-memory cache for prebuilt transactions keyed by obligation pubkey
 */
export class PresubmitCache {
  private cache: Map<string, PresubmitEntry> = new Map();
  
  /**
   * Get cached entry for obligation
   */
  get(obligationPubkey: string): PresubmitEntry | undefined {
    return this.cache.get(obligationPubkey);
  }
  
  /**
   * Set cached entry for obligation
   */
  set(obligationPubkey: string, entry: PresubmitEntry): void {
    this.cache.set(obligationPubkey, entry);
  }
  
  /**
   * Check if entry exists and is fresh
   */
  has(obligationPubkey: string): boolean {
    return this.cache.has(obligationPubkey);
  }
  
  /**
   * Delete cached entry
   */
  delete(obligationPubkey: string): boolean {
    return this.cache.delete(obligationPubkey);
  }
  
  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
  }
  
  /**
   * Get all cached obligation pubkeys
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }
  
  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }
  
  /**
   * Check if cached tx is still fresh (blockhash and TTL checks)
   * @param obligationPubkey - Obligation pubkey
   * @param currentBlockhash - Current blockhash from RPC
   * @param maxAgeMs - Maximum age in milliseconds (default: from PRESUBMIT_TTL_MS env)
   * @returns true if entry is fresh and can be used
   */
  isFresh(obligationPubkey: string, currentBlockhash: string, maxAgeMs?: number): boolean {
    const entry = this.get(obligationPubkey);
    if (!entry) return false;
    
    // Check blockhash staleness
    if (entry.blockhash !== currentBlockhash) {
      console.log(`[Presubmit] Cache entry stale for ${obligationPubkey}: blockhash mismatch`);
      return false;
    }
    
    // Check TTL
    const ttl = maxAgeMs ?? Number(process.env.PRESUBMIT_TTL_MS ?? 60000); // default 60s
    const age = Date.now() - entry.builtAt;
    if (age > ttl) {
      console.log(`[Presubmit] Cache entry stale for ${obligationPubkey}: age ${age}ms > TTL ${ttl}ms`);
      return false;
    }
    
    return true;
  }
}

/**
 * Presubmitter configuration
 */
export interface PresubmitterConfig {
  connection: Connection;
  signer: Keypair;
  market: PublicKey;
  programId: PublicKey;
  topK: number; // number of top plans to prebuild
  refreshMs: number; // minimum refresh interval per obligation
}

/**
 * Presubmitter class for building and caching ready-to-send transactions
 */
export class Presubmitter {
  private cache: PresubmitCache;
  private config: PresubmitterConfig;
  private lastRefresh: Map<string, number> = new Map(); // obligation -> timestamp
  
  constructor(config: PresubmitterConfig) {
    this.cache = new PresubmitCache();
    this.config = config;
  }
  
  /**
   * Get cached transaction if fresh, otherwise rebuild
   */
  async getOrBuild(plan: FlashloanPlan): Promise<PresubmitEntry> {
    const obligationPubkey = plan.obligationPubkey;
    if (!obligationPubkey) {
      throw new Error('[Presubmit] Plan missing obligationPubkey');
    }
    
    // Check if we have a fresh cached entry
    const bh = await this.config.connection.getLatestBlockhash();
    if (this.cache.isFresh(obligationPubkey, bh.blockhash)) {
      const entry = this.cache.get(obligationPubkey);
      if (entry) {
        console.log(`[Presubmit] Using cached tx for ${obligationPubkey} (age: ${Date.now() - entry.builtAt}ms)`);
        return entry;
      }
    }
    
    // Check refresh throttle
    const lastRefresh = this.lastRefresh.get(obligationPubkey) ?? 0;
    const timeSinceRefresh = Date.now() - lastRefresh;
    if (timeSinceRefresh < this.config.refreshMs) {
      console.log(`[Presubmit] Throttling refresh for ${obligationPubkey} (${timeSinceRefresh}ms < ${this.config.refreshMs}ms)`);
      // Return stale entry if available
      const entry = this.cache.get(obligationPubkey);
      if (entry) return entry;
      // Otherwise fall through to rebuild
    }
    
    // Rebuild transaction
    console.log(`[Presubmit] Building tx for ${obligationPubkey}`);
    const entry = await this.buildEntry(plan);
    
    // Update cache and refresh timestamp
    this.cache.set(obligationPubkey, entry);
    this.lastRefresh.set(obligationPubkey, Date.now());
    
    return entry;
  }
  
  /**
   * Build presubmit entry for a plan
   */
  private async buildEntry(plan: FlashloanPlan): Promise<PresubmitEntry> {
    // Import executor helpers
    const { buildKaminoFlashloanIxs } = await import('../flashloan/kaminoFlashloan.js');
    const { buildKaminoLiquidationIxs } = await import('../kamino/liquidationBuilder.js');
    const { buildJupiterSwapIxs, formatBaseUnitsToUiString } = await import('../execute/swapBuilder.js');
    const { buildComputeBudgetIxs } = await import('../execution/computeBudget.js');
    const { estimateSeizedCollateralDeltaBaseUnits } = await import('../execute/seizedDeltaEstimator.js');
    const { resolveMint } = await import('../utils/mintResolve.js');
    
    const ixs = [];
    
    // 1) ComputeBudget
    const cuLimit = Number(process.env.EXEC_CU_LIMIT ?? 600_000);
    const cuPrice = Number(process.env.EXEC_CU_PRICE ?? 0);
    const computeIxs = buildComputeBudgetIxs({ cuLimit, cuPriceMicroLamports: cuPrice });
    ixs.push(...computeIxs);
    
    const borrowIxIndex = ixs.length;
    
    // 2) FlashBorrow
    const mint = (plan.mint || 'USDC') as 'USDC' | 'SOL';
    const amountUi = String(plan.amountUi ?? plan.amountUsd ?? '100');
    const flashloan = await buildKaminoFlashloanIxs({
      connection: this.config.connection,
      marketPubkey: this.config.market,
      programId: this.config.programId,
      signer: this.config.signer,
      mint,
      amountUi,
      borrowIxIndex,
    });
    ixs.push(flashloan.flashBorrowIx);
    
    // 3) Liquidation (refresh + repay/seize)
    let repayMintPreference: PublicKey | undefined;
    if (plan.repayMint) {
      try {
        repayMintPreference = resolveMint(plan.repayMint);
      } catch (err) {
        console.error(
          `[Presubmit] Failed to resolve repayMint for plan ${plan.key} (obligation: ${plan.obligationPubkey}):`,
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      }
    }
    
    const liquidationResult = await buildKaminoLiquidationIxs({
      connection: this.config.connection,
      marketPubkey: this.config.market,
      programId: this.config.programId,
      obligationPubkey: new PublicKey(plan.obligationPubkey),
      liquidatorPubkey: this.config.signer.publicKey,
      repayMintPreference,
      repayAmountUi: plan.amountUi,
    });
    
    ixs.push(...liquidationResult.refreshIxs);
    ixs.push(...liquidationResult.liquidationIxs);
    
    const { repayMint, collateralMint } = liquidationResult;
    
    // Track expected seized and output amounts
    let expectedSeized: bigint | undefined;
    let expectedOut: bigint | undefined;
    
    // 4) Optional swap (if collateral != repay)
    if (!collateralMint.equals(repayMint)) {
      console.log(`[Presubmit] Swap needed: ${collateralMint.toBase58().slice(0, 8)} -> ${repayMint.toBase58().slice(0, 8)}`);
      
      // Build pre-sim tx for seized delta estimation
      const preSimIxs = [...ixs];
      const bh = await this.config.connection.getLatestBlockhash();
      const msg = new TransactionMessage({
        payerKey: this.config.signer.publicKey,
        recentBlockhash: bh.blockhash,
        instructions: preSimIxs,
      });
      const compiledMsg = msg.compileToLegacyMessage();
      const preSimTx = new VersionedTransaction(compiledMsg);
      preSimTx.sign([this.config.signer]);
      
      // Estimate seized collateral
      try {
        const seizedCollateralBaseUnits = await estimateSeizedCollateralDeltaBaseUnits({
          connection: this.config.connection,
          liquidator: this.config.signer.publicKey,
          collateralMint,
          simulateTx: preSimTx,
        });
        
        expectedSeized = seizedCollateralBaseUnits;
        
        // Apply haircut
        const haircutBps = Number(process.env.SWAP_IN_HAIRCUT_BPS ?? 100);
        const haircutMultiplier = 10000n - BigInt(haircutBps);
        const inAmountBaseUnits = (seizedCollateralBaseUnits * haircutMultiplier) / 10000n;
        
        // Log for debugging
        const collateralDecimals = plan.collateralDecimals ?? 9;
        const inAmountUi = formatBaseUnitsToUiString(inAmountBaseUnits, collateralDecimals);
        console.log(`[Presubmit]   Seized: ${inAmountUi} (after ${haircutBps} bps haircut)`);
        
        // Build swap
        const slippageBps = Number(process.env.SWAP_SLIPPAGE_BPS ?? 100);
        const swapResult = await buildJupiterSwapIxs({
          inputMint: collateralMint,
          outputMint: repayMint,
          inAmountBaseUnits,
          slippageBps,
          userPubkey: this.config.signer.publicKey,
          connection: this.config.connection,
        });
        
        expectedOut = swapResult.estimatedOutAmountBaseUnits;
        
        // Add swap instructions
        ixs.push(...swapResult.setupIxs);
        ixs.push(...swapResult.swapIxs);
        ixs.push(...swapResult.cleanupIxs);
        
        console.log(`[Presubmit]   Swap: ${swapResult.setupIxs.length + swapResult.swapIxs.length + swapResult.cleanupIxs.length} instructions`);
      } catch (err) {
        console.error('[Presubmit] Failed to build swap:', err instanceof Error ? err.message : String(err));
        throw new Error(
          `Swap required but failed to build for ${plan.obligationPubkey}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    
    // 5) FlashRepay
    ixs.push(flashloan.flashRepayIx);
    
    // Build final transaction
    const bh = await this.config.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: this.config.signer.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: ixs,
    });
    const compiledMsg = msg.compileToLegacyMessage();
    const tx = new VersionedTransaction(compiledMsg);
    tx.sign([this.config.signer]);
    
    // Simulate to get slot
    let lastSimSlot: number | undefined;
    try {
      const sim = await this.config.connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      
      if (!sim.value.err) {
        // Extract slot from context if available
        lastSimSlot = sim.context?.slot;
      } else {
        console.warn(`[Presubmit] Simulation failed for ${plan.obligationPubkey}:`, sim.value.err);
      }
    } catch (err) {
      console.warn(`[Presubmit] Simulation error for ${plan.obligationPubkey}:`, err instanceof Error ? err.message : String(err));
    }
    
    return {
      tx,
      builtAt: Date.now(),
      lastSimSlot,
      expectedSeized,
      expectedOut,
      ev: plan.ev,
      ttl: plan.ttlMin,
      blockhash: bh.blockhash,
    };
  }
  
  /**
   * Prebuild transactions for top K plans
   * @param plans - Array of plans sorted by priority
   * @returns Number of transactions built
   */
  async prebuildTopK(plans: FlashloanPlan[]): Promise<number> {
    const topK = Math.min(this.config.topK, plans.length);
    const topPlans = plans.slice(0, topK);
    
    console.log(`[Presubmit] Prebuilding top ${topK} plans...`);
    
    let built = 0;
    for (const plan of topPlans) {
      if (!plan.obligationPubkey) {
        console.warn(`[Presubmit] Skipping plan without obligationPubkey: ${plan.key}`);
        continue;
      }
      
      try {
        await this.getOrBuild(plan);
        built++;
      } catch (err) {
        console.error(
          `[Presubmit] Failed to build plan ${plan.key} (${plan.obligationPubkey}):`,
          err instanceof Error ? err.message : String(err)
        );
        // Continue with other plans
      }
    }
    
    console.log(`[Presubmit] Built ${built}/${topK} transactions`);
    return built;
  }
  
  /**
   * Evict stale entries from cache
   * @param currentBlockhash - Current blockhash from RPC
   * @returns Number of entries evicted
   */
  evictStale(currentBlockhash: string): number {
    const before = this.cache.size();
    const staleKeys: string[] = [];
    
    for (const key of this.cache.keys()) {
      if (!this.cache.isFresh(key, currentBlockhash)) {
        staleKeys.push(key);
      }
    }
    
    for (const key of staleKeys) {
      this.cache.delete(key);
    }
    
    const evicted = before - this.cache.size();
    if (evicted > 0) {
      console.log(`[Presubmit] Evicted ${evicted} stale entries`);
    }
    
    return evicted;
  }
  
  /**
   * Get cache statistics
   */
  stats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size(),
      keys: this.cache.keys(),
    };
  }
}
