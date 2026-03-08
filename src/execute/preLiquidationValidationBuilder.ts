import {
  Connection,
  PublicKey,
  TransactionInstruction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';
import { loadEnv } from '../config/env.js';
import { buildKaminoLiquidationIxs } from '../kamino/liquidationBuilder.js';

export interface PreLiquidationValidationBuild {
  instructions: TransactionInstruction[];
  labels: string[];
  lookupTables?: AddressLookupTableAccount[];
  source: 'pre-liquidation-refresh';
}

export async function buildPreLiquidationValidationPath(args: {
  connection: Connection;
  plan: FlashloanPlan;
  feePayer: PublicKey;
}): Promise<PreLiquidationValidationBuild> {
  const env = loadEnv();
  if (!args.plan.repayReservePubkey || !args.plan.collateralReservePubkey) {
    throw new Error('Plan is missing repay/collateral reserve pubkeys required for pre-liquidation validation');
  }

  const built = await buildKaminoLiquidationIxs({
    connection: args.connection,
    marketPubkey: new PublicKey(env.KAMINO_MARKET_PUBKEY),
    programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
    obligationPubkey: new PublicKey(args.plan.obligationPubkey),
    liquidatorPubkey: args.feePayer,
    expectedRepayReservePubkey: new PublicKey(args.plan.repayReservePubkey),
    expectedCollateralReservePubkey: new PublicKey(args.plan.collateralReservePubkey),
    repayAmountUi: '0.000001',
  });

  const labels: string[] = [];
  labels.push(...built.preReserveIxs.map((_, idx) => `preRefreshReserve:${idx}`));
  labels.push(...built.coreIxs.map((_, idx) => (idx === 0 ? 'refreshObligation' : `refreshObligation:${idx}`)));
  labels.push(...built.preFarmIxs.map((_, idx) => `refreshFarms:pre:${idx}`));
  labels.push(...built.postFarmIxs.map((_, idx) => `refreshFarms:post:${idx}`));

  return {
    instructions: [...built.preReserveIxs, ...built.coreIxs, ...built.preFarmIxs, ...built.postFarmIxs],
    labels,
    source: 'pre-liquidation-refresh',
  };
}

