import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import * as candidateSelector from "../strategy/candidateSelector.js";
import type { ScoredObligation } from "../strategy/candidateSelector.js";
import {
  buildCandidateSelectorConfigFromEnv,
  rankCandidatesWithBoundedKlendVerification,
} from "../strategy/rankCandidatesForSelection.js";

const applyMock = vi.fn();

vi.mock("../engine/applyKlendSdkVerification.js", () => ({
  applyKlendSdkVerificationToCandidates: (...args: unknown[]) => applyMock(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = path.join(repoRoot, "src");

function findTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findTsFiles(fullPath);
    if (entry.isFile() && fullPath.endsWith(".ts")) return [fullPath];
    return [];
  });
}

function makeEnv(overrides: Record<string, string | number | undefined> = {}) {
  return {
    USE_EV_RANKING: "false",
    MIN_BORROW_USD: "10",
    HAZARD_ALPHA: "25",
    FORECAST_TTL_MS: "300000",
    TTL_VOLATILE_MOVE_PCT_PER_MIN: undefined,
    TTL_STABLE_MOVE_PCT_PER_MIN: "0.02",
    TTL_SOL_DROP_PCT_PER_MIN: "0.2",
    TTL_MAX_DROP_PCT: "20",
    EV_CLOSE_FACTOR: "0.5",
    EV_LIQUIDATION_BONUS_PCT: "0.05",
    EV_FLASHLOAN_FEE_PCT: "0.002",
    EV_FIXED_GAS_USD: "0.5",
    EV_SLIPPAGE_BUFFER_PCT: undefined,
    LIQSOL_RECOMPUTED_VERIFY_BACKEND: "klend-sdk",
    LIQSOL_RECOMPUTED_VERIFY_TOP_K: 10,
    LIQSOL_RECOMPUTED_VERIFY_CONCURRENCY: 1,
    LIQSOL_RECOMPUTED_VERIFY_TTL_MS: 15000,
    LIQSOL_HEALTH_SOURCE: "recomputed",
    ...overrides,
  } as any;
}

function makeScored(
  obligationPubkey: string,
  healthRatio: number,
  borrowValueUsd = 100
): ScoredObligation {
  return {
    obligationPubkey,
    ownerPubkey: PublicKey.unique().toBase58(),
    healthRatio,
    healthRatioRaw: healthRatio,
    liquidationEligible: healthRatio < 1,
    borrowValueUsd,
    collateralValueUsd: borrowValueUsd * healthRatio,
    repayReservePubkey: PublicKey.unique().toBase58(),
    collateralReservePubkey: PublicKey.unique().toBase58(),
    healthSource: "recomputed",
  };
}

describe("candidate ranking flow alignment", () => {
  it("buildCandidateSelectorConfigFromEnv maps env knobs into selector config", () => {
    const cfg = buildCandidateSelectorConfigFromEnv(
      makeEnv({
        USE_EV_RANKING: "true",
        MIN_BORROW_USD: "123",
        HAZARD_ALPHA: "9",
        FORECAST_TTL_MS: "4567",
        TTL_VOLATILE_MOVE_PCT_PER_MIN: "0.9",
        TTL_STABLE_MOVE_PCT_PER_MIN: "0.03",
        TTL_SOL_DROP_PCT_PER_MIN: "0.7",
        TTL_MAX_DROP_PCT: "11",
        EV_CLOSE_FACTOR: "0.33",
        EV_LIQUIDATION_BONUS_PCT: "0.06",
        EV_FLASHLOAN_FEE_PCT: "0.004",
        EV_FIXED_GAS_USD: "0.75",
        EV_SLIPPAGE_BUFFER_PCT: "0.08",
      }),
      1.015
    );

    expect(cfg).toEqual({
      nearThreshold: 1.015,
      useEvRanking: true,
      minBorrowUsd: 123,
      hazardAlpha: 9,
      forecastTtlMs: 4567,
      ttlVolatileMovePctPerMin: 0.9,
      ttlStableMovePctPerMin: 0.03,
      ttlMaxMovePct: 11,
      legacySolDropPctPerMin: 0.7,
      evParams: {
        closeFactor: 0.33,
        liquidationBonusPct: 0.06,
        flashloanFeePct: 0.004,
        fixedGasUsd: 0.75,
        slippageBufferPct: 0.08,
      },
    });

    const cfgNoFiniteSlippage = buildCandidateSelectorConfigFromEnv(
      makeEnv({ EV_SLIPPAGE_BUFFER_PCT: "not-a-number" }),
      1.02
    );
    expect(cfgNoFiniteSlippage.evParams?.slippageBufferPct).toBeUndefined();
  });

  it("falls back to legacy volatile env knob when TTL_VOLATILE_MOVE_PCT_PER_MIN is absent", () => {
    const cfg = buildCandidateSelectorConfigFromEnv(
      makeEnv({
        TTL_VOLATILE_MOVE_PCT_PER_MIN: undefined,
        TTL_SOL_DROP_PCT_PER_MIN: "0.77",
      }),
      1.02
    );

    expect(cfg.ttlVolatileMovePctPerMin).toBe(0.77);
    expect(cfg.legacySolDropPctPerMin).toBe(0.77);
    expect(cfg.ttlStableMovePctPerMin).toBe(0.02);
  });

  it("uses EV-enabled config for selectCandidates before and after bounded sdk mutation", async () => {
    const selectSpy = vi.spyOn(candidateSelector, "selectCandidates");
    applyMock.mockImplementation(async ({ candidates }: { candidates: ScoredObligation[] }) => {
      const c = candidates.find((x) => x.obligationPubkey === "mutated");
      if (c) {
        c.healthRatio = 0.95;
        c.healthRatioRaw = 0.95;
        c.liquidationEligible = true;
      }
    });

    await rankCandidatesWithBoundedKlendVerification({
      scoredCandidates: [makeScored("stable", 1.02, 150), makeScored("mutated", 1.2, 100)],
      nearThreshold: 1.02,
      topN: 2,
      env: makeEnv({ USE_EV_RANKING: "true", EV_SLIPPAGE_BUFFER_PCT: "0.02" }),
      marketPubkey: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });

    expect(selectSpy).toHaveBeenCalledTimes(2);
    expect(selectSpy.mock.calls[0]?.[1]).toMatchObject({
      nearThreshold: 1.02,
      useEvRanking: true,
    });
    expect(selectSpy.mock.calls[1]?.[1]).toMatchObject({
      nearThreshold: 1.02,
      useEvRanking: true,
    });
  });

  it("re-ranks after sdk mutation and can change final top order", async () => {
    applyMock.mockImplementation(async ({ candidates }: { candidates: ScoredObligation[] }) => {
      const c = candidates.find((x) => x.obligationPubkey === "becomes-best-after-sdk");
      if (c) {
        c.healthRatio = 0.9;
        c.healthRatioRaw = 0.9;
        c.liquidationEligible = true;
      }
    });

    const result = await rankCandidatesWithBoundedKlendVerification({
      scoredCandidates: [
        makeScored("best-initial", 1.01, 120),
        makeScored("becomes-best-after-sdk", 1.2, 90),
      ],
      nearThreshold: 1.02,
      topN: 1,
      env: makeEnv({ USE_EV_RANKING: "false" }),
      marketPubkey: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });

    expect(result.topCandidates[0]?.obligationPubkey).toBe("becomes-best-after-sdk");
  });

  it("buildCandidates.ts and snapshotCandidates.ts both use shared ranking helper", () => {
    const filesUsingHelper = findTsFiles(srcRoot).filter((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return source.includes("strategy/rankCandidatesForSelection.js");
    });

    expect(filesUsingHelper.some((p) => p.endsWith(path.join("pipeline", "buildCandidates.ts")))).toBe(true);
    expect(filesUsingHelper.some((p) => p.endsWith(path.join("commands", "snapshotCandidates.ts")))).toBe(true);
  });

  it("EV ranking adds TTL forecast model metadata when ttlContext is present", async () => {
    applyMock.mockResolvedValue(undefined);
    const result = await rankCandidatesWithBoundedKlendVerification({
      scoredCandidates: [
        {
          ...makeScored("ttl-model", 1.1, 200),
          ttlContext: {
            deposits: [
              {
                mint: "So11111111111111111111111111111111111111112",
                usdRaw: 120,
                usdWeighted: 120,
                shareOfWeightedSide: 1,
                assetClass: "volatile",
              },
            ],
            borrows: [
              {
                mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                usdRaw: 100,
                usdWeighted: 100,
                shareOfWeightedSide: 1,
                assetClass: "stable",
              },
            ],
            totalCollateralUsdAdj: 110,
            totalBorrowUsdAdj: 100,
            totalCollateralUsdRaw: 110,
            totalBorrowUsdRaw: 100,
            activeDepositCount: 1,
            activeBorrowCount: 1,
          },
        },
      ],
      nearThreshold: 1.02,
      topN: 1,
      env: makeEnv({ USE_EV_RANKING: "true" }),
      marketPubkey: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });

    expect(result.topCandidates[0]?.forecast?.model).toBeDefined();
    expect(result.topCandidates[0]?.forecast?.confidence).toBeDefined();
  });

  it("keeps legacy priorityScore ordering when USE_EV_RANKING=false", async () => {
    applyMock.mockResolvedValue(undefined);
    const result = await rankCandidatesWithBoundedKlendVerification({
      scoredCandidates: [makeScored("liq", 0.98, 100), makeScored("safe", 1.5, 5000)],
      nearThreshold: 1.02,
      topN: 2,
      env: makeEnv({ USE_EV_RANKING: "false" }),
      marketPubkey: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });

    expect(result.rankedCandidates[0]?.obligationPubkey).toBe("liq");
    expect(result.rankedCandidates[0]?.ev).toBeUndefined();
  });
});
