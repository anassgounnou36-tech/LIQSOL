import { KaminoMarket, PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { address, createSolanaRpc } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { logger } from "../observability/logger.js";

export interface KlendSdkVerifierConfig {
  rpcUrl: string;
  marketPubkey: PublicKey;
  programId?: PublicKey;
  cacheTtlMs: number;
}

export interface KlendSdkVerificationInput {
  obligationPubkey: string;
  ownerPubkey: string;
}

export type KlendSdkVerificationResult =
  | {
      ok: true;
      healthRatioSdkRaw: number;
      healthRatioSdk: number;
      borrowUsdAdjSdk: number;
      collateralUsdAdjSdk: number;
    }
  | {
      ok: false;
      reason: string;
    };

type CachedVerification = {
  atMs: number;
  result: KlendSdkVerificationResult;
};

class KlendSdkVerifier {
  private readonly rpc: ReturnType<typeof createSolanaRpc>;
  private readonly marketAddress: ReturnType<typeof address>;
  private readonly programAddress: ReturnType<typeof address>;
  private readonly cache = new Map<string, CachedVerification>();
  private marketPromise: Promise<KaminoMarket | null> | null = null;
  private lastMarketRefreshMs = 0;

  constructor(private readonly config: KlendSdkVerifierConfig) {
    this.rpc = createSolanaRpc(this.config.rpcUrl);
    this.marketAddress = address(this.config.marketPubkey.toBase58());
    this.programAddress = this.config.programId ? address(this.config.programId.toBase58()) : PROGRAM_ID;
  }

  private async getMarket(): Promise<KaminoMarket | null> {
    if (!this.marketPromise) {
      this.marketPromise = KaminoMarket.load(
        this.rpc as unknown as any,
        this.marketAddress,
        400,
        this.programAddress
      );
    }
    return this.marketPromise;
  }

  private async refreshMarketIfNeeded(): Promise<KaminoMarket | null> {
    const market = await this.getMarket();
    if (!market) return null;

    const now = Date.now();
    if (now - this.lastMarketRefreshMs >= this.config.cacheTtlMs) {
      await market.refreshAll();
      this.lastMarketRefreshMs = now;
    }

    return market;
  }

  private getCached(obligationPubkey: string): KlendSdkVerificationResult | undefined {
    const entry = this.cache.get(obligationPubkey);
    if (!entry) return undefined;
    if (Date.now() - entry.atMs > this.config.cacheTtlMs) {
      this.cache.delete(obligationPubkey);
      return undefined;
    }
    return entry.result;
  }

  private setCached(obligationPubkey: string, result: KlendSdkVerificationResult): void {
    this.cache.set(obligationPubkey, { atMs: Date.now(), result });
  }

  async verify(input: KlendSdkVerificationInput): Promise<KlendSdkVerificationResult> {
    const cached = this.getCached(input.obligationPubkey);
    if (cached) return cached;

    try {
      const market = await this.refreshMarketIfNeeded();
      if (!market) {
        const result = { ok: false, reason: "market-not-found" } as const;
        this.setCached(input.obligationPubkey, result);
        return result;
      }

      const obligations = await market.getAllUserObligations(address(input.ownerPubkey));
      const obligation = obligations.find((o) => o.obligationAddress.toString() === input.obligationPubkey);
      if (!obligation) {
        const result = { ok: false, reason: "obligation-not-found" } as const;
        this.setCached(input.obligationPubkey, result);
        return result;
      }

      const borrowUsdAdjSdk = obligation.refreshedStats.userTotalBorrowBorrowFactorAdjusted.toNumber();
      const collateralUsdAdjSdk = obligation.refreshedStats.borrowLiquidationLimit.toNumber();
      if (!Number.isFinite(borrowUsdAdjSdk) || !Number.isFinite(collateralUsdAdjSdk) || borrowUsdAdjSdk <= 0) {
        const result = { ok: false, reason: "invalid-refreshed-stats" } as const;
        this.setCached(input.obligationPubkey, result);
        return result;
      }

      const healthRatioSdkRaw = collateralUsdAdjSdk / borrowUsdAdjSdk;
      const healthRatioSdk = Math.max(0, Math.min(2, healthRatioSdkRaw));
      const result: KlendSdkVerificationResult = {
        ok: true,
        healthRatioSdkRaw,
        healthRatioSdk,
        borrowUsdAdjSdk,
        collateralUsdAdjSdk,
      };
      this.setCached(input.obligationPubkey, result);
      return result;
    } catch (error) {
      logger.warn(
        { err: error, obligationPubkey: input.obligationPubkey, ownerPubkey: input.ownerPubkey },
        "klend-sdk verification failed"
      );
      return { ok: false, reason: "verify-error" };
    }
  }
}

const verifiers = new Map<string, KlendSdkVerifier>();

export function getKlendSdkVerifier(config: KlendSdkVerifierConfig): KlendSdkVerifier {
  const programIdString = config.programId ? config.programId.toBase58() : PROGRAM_ID.toString();
  const key = `${config.rpcUrl}|${config.marketPubkey.toBase58()}|${programIdString}|${config.cacheTtlMs}`;
  const existing = verifiers.get(key);
  if (existing) return existing;
  const verifier = new KlendSdkVerifier(config);
  verifiers.set(key, verifier);
  return verifier;
}
