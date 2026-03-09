import { PublicKey } from '@solana/web3.js';
import type { Connection, TransactionInstruction } from '@solana/web3.js';

export interface PriorityFeeQuote {
  mode: 'static' | 'recent-fees';
  writableAccountsSampled: number;
  observedSamples: number;
  observedNonZeroSamples: number;
  percentile: number;
  recommendedMicroLamports: number;
  floorMicroLamports: number;
  capMicroLamports: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function percentileNearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((clamp(percentile, 0, 100) / 100) * sorted.length);
  const idx = clamp(rank - 1, 0, sorted.length - 1);
  return sorted[idx];
}

export function deriveWritableAccountsFromInstructions(args: {
  instructions: TransactionInstruction[];
  payer: PublicKey;
  maxAccounts: number;
}): string[] {
  const { instructions, payer } = args;
  const maxAccounts = Math.max(0, Math.min(128, args.maxAccounts));
  if (maxAccounts === 0) return [];

  const seen = new Set<string>();
  const writable: string[] = [];
  const pushUnique = (key: string) => {
    if (seen.has(key) || writable.length >= maxAccounts) return;
    seen.add(key);
    writable.push(key);
  };

  pushUnique(payer.toBase58());
  for (const ix of instructions) {
    for (const key of ix.keys) {
      if (!key.isWritable) continue;
      pushUnique(key.pubkey.toBase58());
    }
  }
  return writable;
}

export async function quotePriorityFeeMicroLamports(args: {
  connection: Connection;
  instructions: TransactionInstruction[];
  payer: PublicKey;
  staticMicroLamports: number;
  mode: 'static' | 'recent-fees';
  percentile: number;
  floorMicroLamports: number;
  capMicroLamports: number;
  maxAccounts: number;
}): Promise<PriorityFeeQuote> {
  const {
    connection,
    instructions,
    payer,
    staticMicroLamports,
    mode,
    percentile,
    floorMicroLamports,
    capMicroLamports,
    maxAccounts,
  } = args;
  const floor = Math.max(0, floorMicroLamports);
  const cap = Math.max(floor, capMicroLamports);
  const staticPrice = Math.max(0, staticMicroLamports);
  const accountList = deriveWritableAccountsFromInstructions({
    instructions,
    payer,
    maxAccounts,
  });

  if (mode === 'static') {
    return {
      mode,
      writableAccountsSampled: accountList.length,
      observedSamples: 0,
      observedNonZeroSamples: 0,
      percentile,
      recommendedMicroLamports: staticPrice,
      floorMicroLamports: floor,
      capMicroLamports: cap,
    };
  }

  try {
    const fees = await connection.getRecentPrioritizationFees({
      lockedWritableAccounts: accountList.map((k) => new PublicKey(k)),
    });
    const values = fees.map((f) => Number(f.prioritizationFee)).filter((v) => Number.isFinite(v));
    if (values.length === 0) {
      return {
        mode: 'static',
        writableAccountsSampled: accountList.length,
        observedSamples: 0,
        observedNonZeroSamples: 0,
        percentile,
        recommendedMicroLamports: staticPrice,
        floorMicroLamports: floor,
        capMicroLamports: cap,
      };
    }
    const nonZero = values.filter((v) => v > 0);
    const sampleSet = nonZero.length > 0 ? nonZero : values;
    const percentileValue = percentileNearestRank(sampleSet, percentile);
    const recommendedMicroLamports = clamp(
      Math.max(staticPrice, percentileValue),
      floor,
      cap
    );
    return {
      mode: 'recent-fees',
      writableAccountsSampled: accountList.length,
      observedSamples: values.length,
      observedNonZeroSamples: nonZero.length,
      percentile,
      recommendedMicroLamports,
      floorMicroLamports: floor,
      capMicroLamports: cap,
    };
  } catch {
    return {
      mode: 'static',
      writableAccountsSampled: accountList.length,
      observedSamples: 0,
      observedNonZeroSamples: 0,
      percentile,
      recommendedMicroLamports: staticPrice,
      floorMicroLamports: floor,
      capMicroLamports: cap,
    };
  }
}
