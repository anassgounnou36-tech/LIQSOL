export interface FlashloanPlan {
  key: string;
  ownerPubkey?: string;
  mint: 'USDC' | 'SOL' | string;
  amountUi?: string; // for USDC plans only; other mints convert at dispatch
  amountUsd: number;
  ev: number;
  hazard: number;
  ttlMin: number;
  createdAtMs: number;
}

export function buildPlanFromCandidate(c: any, defaultMint: 'USDC' | 'SOL' = 'USDC'): FlashloanPlan {
  const mint = c.borrowMint ?? c.primaryBorrowMint ?? defaultMint;
  const amountUsd = Number(c.borrowValueUsd ?? 0);
  const amountUi = mint === 'USDC' ? amountUsd.toFixed(2) : undefined;
  return {
    key: c.key ?? c.obligationPubkey ?? 'unknown',
    ownerPubkey: c.ownerPubkey,
    mint,
    amountUi,
    amountUsd,
    ev: Number(c.ev ?? 0),
    hazard: Number(c.hazard ?? 0),
    ttlMin: Number(c.ttlMin ?? Infinity),
    createdAtMs: Date.now(),
  };
}
