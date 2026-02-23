import { Connection, PublicKey, VersionedTransaction, Keypair } from '@solana/web3.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';
import { buildPlanTransactions } from '../execute/planTxBuilder.js';
import { buildVersionedTx } from '../execute/versionedTx.js';

/**
 * Presubmit cache entry for a ready-to-send transaction
 */
export type PresubmitEntry = {
  tx?: VersionedTransaction;
  builtAt: number; // timestamp in ms
  lastSimSlot?: number;
  expectedSeized?: bigint;
  expectedOut?: bigint;
  ev?: number;
  ttl?: number;
  blockhash: string;
  lookupTablesCount: number;
  mode: 'atomic' | 'main' | 'partial';
  needsSetupFirst?: boolean;
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
    const built = await buildPlanTransactions({
      connection: this.config.connection,
      signer: this.config.signer,
      market: this.config.market,
      programId: this.config.programId,
      plan,
      includeSwap: true,
      useRealSwapSizing: true,
      dry: false,
    });

    const swapRequired = !built.collateralMint.equals(built.repayMint);
    const swapSkippedBecauseSetup = built.setupIxs.length > 0 && swapRequired && built.swapIxs.length === 0;

    const bh = await this.config.connection.getLatestBlockhash();
    let tx: VersionedTransaction | undefined;
    let mode: PresubmitEntry['mode'] = 'partial';

    if (!swapSkippedBecauseSetup) {
      mode = built.atomicIxs.length > built.mainIxs.length ? 'atomic' : 'main';
      tx = await buildVersionedTx({
        payer: this.config.signer.publicKey,
        blockhash: bh.blockhash,
        instructions: mode === 'atomic' ? built.atomicIxs : built.mainIxs,
        lookupTables: mode === 'atomic' ? built.atomicLookupTables : built.swapLookupTables,
        signer: this.config.signer,
      });
    }

    // Simulate to get slot
    let lastSimSlot: number | undefined;
    if (tx) {
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
    }
    
    return {
      tx,
      builtAt: Date.now(),
      lastSimSlot,
      ev: plan.ev,
      ttl: plan.ttlMin ?? undefined,
      blockhash: bh.blockhash,
      lookupTablesCount: built.atomicLookupTables.length,
      mode,
      needsSetupFirst: swapSkippedBecauseSetup || undefined,
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
