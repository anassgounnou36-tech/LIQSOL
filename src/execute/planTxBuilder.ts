import { AddressLookupTableAccount, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { buildKaminoRefreshAndLiquidateIxsCanonical } from '../kamino/canonicalLiquidationIxs.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';
import { resolveMintFlexible } from '../solana/mint.js';
import { buildJupiterSwapIxs, formatBaseUnitsToUiString } from './swapBuilder.js';
import { estimateSeizedCollateralDeltaBaseUnits } from './seizedDeltaEstimator.js';

export type BuiltPlanTx = {
  setupIxs: TransactionInstruction[];
  setupLabels: string[];
  missingAtas: Array<{ mint: string; ataAddress: string; purpose: 'repay'|'collateral'|'withdrawLiq' }>;

  mainIxs: TransactionInstruction[];
  mainLabels: string[];
  hasFarmsRefresh: boolean;
  hasPostFarmsRefresh: boolean;
  farmRequiredModes: number[];

  swapIxs: TransactionInstruction[];
  swapLookupTables: AddressLookupTableAccount[];

  atomicIxs: TransactionInstruction[];
  atomicLabels: string[];
  atomicLookupTables: AddressLookupTableAccount[];

  repayMint: PublicKey;
  collateralMint: PublicKey;
  withdrawCollateralMint: PublicKey;
};

export async function buildPlanTransactions(opts: {
  connection: Connection;
  signer: Keypair;
  market: PublicKey;
  programId: PublicKey;
  plan: FlashloanPlan;
  includeSwap: boolean;
  useRealSwapSizing: boolean;
  dry: boolean;
  preReserveRefreshModeOverride?: 'all' | 'primary' | 'auto';
  disableFarmsRefresh?: boolean;
  disablePostFarmsRefresh?: boolean;
  omitComputeBudgetIxs?: boolean;
  refreshObligationMode?: 'active' | 'nonDefault';
}): Promise<BuiltPlanTx> {
  const cuLimit = Number(process.env.EXEC_CU_LIMIT ?? 600_000);
  const cuPrice = Number(process.env.EXEC_CU_PRICE ?? 0);
  const preReserveMode = opts.preReserveRefreshModeOverride ?? (process.env.PRE_RESERVE_REFRESH_MODE ?? 'auto') as 'all' | 'primary' | 'auto';
  let refreshObligationMode: 'active' | 'nonDefault' = opts.refreshObligationMode ?? 'active';

  let repayMintPreference: PublicKey | undefined;
  let expectedRepayReservePubkey: PublicKey | undefined;
  let expectedCollateralReservePubkey: PublicKey | undefined;

  if (opts.plan.repayMint) {
    repayMintPreference = resolveMintFlexible(opts.plan.repayMint);
  }

  if (opts.plan.repayReservePubkey) {
    expectedRepayReservePubkey = new PublicKey(opts.plan.repayReservePubkey);
  }

  if (opts.plan.collateralReservePubkey) {
    expectedCollateralReservePubkey = new PublicKey(opts.plan.collateralReservePubkey);
  }

  const mint = (opts.plan.mint || 'USDC') as string;
  const amountUi = String(opts.plan.amountUi ?? opts.plan.amountUsd ?? '100');

  const canonicalConfig = {
    connection: opts.connection,
    signer: opts.signer,
    marketPubkey: opts.market,
    programId: opts.programId,
    obligationPubkey: new PublicKey(opts.plan.obligationPubkey),
    cuLimit,
    cuPrice,
    flashloan: {
      mint,
      amountUi,
    },
    repayMintPreference,
    repayAmountUi: opts.plan.amountUi,
    expectedRepayReservePubkey,
    expectedCollateralReservePubkey,
    preReserveRefreshMode: preReserveMode,
    disableFarmsRefresh: opts.disableFarmsRefresh,
    disablePostFarmsRefresh: opts.disablePostFarmsRefresh,
    omitComputeBudgetIxs: opts.omitComputeBudgetIxs,
    refreshObligationMode,
  };

  const initialCanonical = await buildKaminoRefreshAndLiquidateIxsCanonical(canonicalConfig);
  const { repayMint, collateralMint, withdrawCollateralMint, hasFarmsRefresh, farmRequiredModes } = initialCanonical;

  let swapIxs: TransactionInstruction[] = [];
  let swapLookupTables: AddressLookupTableAccount[] = [];

  if (opts.includeSwap && !collateralMint.equals(repayMint)) {
    const CUSTOM_6006 = 6006;
    const isRefreshObligation6006 = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes(`"Custom":${CUSTOM_6006}`) || msg.includes(`Custom(${CUSTOM_6006})`);
    };

    if (initialCanonical.setupIxs.length > 0) {
      console.log('[Executor] ⚠️  Swap sizing skipped: Setup required (ATAs missing)');
    } else if (opts.useRealSwapSizing) {
      try {
        const estimateSeizedWithMode = async (mode: 'active' | 'nonDefault') => {
          const simCanonical = await buildKaminoRefreshAndLiquidateIxsCanonical({
            ...canonicalConfig,
            flashloan: undefined,
            preReserveRefreshMode: 'primary',
            refreshObligationMode: mode,
          });

          const bh = await opts.connection.getLatestBlockhash();
          const simMsg = new TransactionMessage({
            payerKey: opts.signer.publicKey,
            recentBlockhash: bh.blockhash,
            instructions: simCanonical.instructions,
          });
          const simTx = new VersionedTransaction(simMsg.compileToLegacyMessage());
          simTx.sign([opts.signer]);

          return estimateSeizedCollateralDeltaBaseUnits({
            connection: opts.connection,
            liquidator: opts.signer.publicKey,
            collateralMint: withdrawCollateralMint,
            simulateTx: simTx,
            instructionLabels: simCanonical.labels,
          });
        };

        let seizedCollateralBaseUnits: bigint;
        try {
          seizedCollateralBaseUnits = await estimateSeizedWithMode(refreshObligationMode);
        } catch (err) {
          if (refreshObligationMode === 'active' && isRefreshObligation6006(err)) {
            console.warn('[Executor] refreshObligation Custom(6006) with ACTIVE slots; retrying once with NON-DEFAULT slots');
            refreshObligationMode = 'nonDefault';
            seizedCollateralBaseUnits = await estimateSeizedWithMode('nonDefault');
          } else {
            throw err;
          }
        }

        const haircutBps = Number(process.env.SWAP_IN_HAIRCUT_BPS ?? 100);
        const haircutMultiplier = 10000n - BigInt(haircutBps);
        const inAmountBaseUnits = (seizedCollateralBaseUnits * haircutMultiplier) / 10000n;

        const slippageBps = Number(process.env.SWAP_SLIPPAGE_BPS ?? 100);
        const swapResult = await buildJupiterSwapIxs({
          inputMint: collateralMint,
          outputMint: repayMint,
          inAmountBaseUnits,
          slippageBps,
          userPubkey: opts.signer.publicKey,
          connection: opts.connection,
        });

        swapIxs = [...swapResult.setupIxs, ...swapResult.swapIxs, ...swapResult.cleanupIxs];
        swapLookupTables = swapResult.lookupTables ?? [];

        if (swapResult.estimatedOutAmountBaseUnits) {
          const repayDecimals = opts.plan.repayDecimals ?? 6;
          const estimatedOutUi = formatBaseUnitsToUiString(swapResult.estimatedOutAmountBaseUnits, repayDecimals);
          console.log(`[Executor]   Estimated output: ${estimatedOutUi} ${repayMint.toBase58().slice(0, 8)}`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (refreshObligationMode === 'nonDefault' && isRefreshObligation6006(err)) {
          throw new Error('refreshObligation-invalid-accounts');
        }
        if (errMsg === 'OBLIGATION_HEALTHY') {
          throw new Error('OBLIGATION_HEALTHY');
        }

        console.error('[Executor] Failed to estimate seized collateral or build swap:', errMsg);
        const enableFallback = (process.env.SWAP_SIZING_FALLBACK_ENABLED ?? 'true') === 'true';
        if (!enableFallback) {
          throw new Error(`Swap required but sizing failed: ${errMsg}`);
        }
      }
    }
  }

  const finalCanonical = await buildKaminoRefreshAndLiquidateIxsCanonical({
    ...canonicalConfig,
    refreshObligationMode,
    swap: swapIxs.length > 0 ? { instructions: swapIxs } : undefined,
  });

  let atomicMainIxs = finalCanonical.instructions;
  let atomicMainLabels = finalCanonical.labels;
  if (finalCanonical.setupIxs.length > 0 && canonicalConfig.flashloan) {
    const atomicCanonical = await buildKaminoRefreshAndLiquidateIxsCanonical({
      ...canonicalConfig,
      refreshObligationMode,
      swap: swapIxs.length > 0 ? { instructions: swapIxs } : undefined,
      flashloanBorrowIxIndexOffset: finalCanonical.setupIxs.length,
    });
    atomicMainIxs = atomicCanonical.instructions;
    atomicMainLabels = atomicCanonical.labels;
  }

  const atomicIxs = [...finalCanonical.setupIxs, ...atomicMainIxs];
  const atomicLabels = [...finalCanonical.setupLabels, ...atomicMainLabels];

  return {
    setupIxs: finalCanonical.setupIxs,
    setupLabels: finalCanonical.setupLabels,
    missingAtas: finalCanonical.missingAtas,
    mainIxs: finalCanonical.instructions,
    mainLabels: finalCanonical.labels,
    hasFarmsRefresh,
    hasPostFarmsRefresh: finalCanonical.hasPostFarmsRefresh,
    farmRequiredModes,
    swapIxs,
    swapLookupTables,
    atomicIxs,
    atomicLabels,
    atomicLookupTables: swapLookupTables,
    repayMint,
    collateralMint,
    withdrawCollateralMint,
  };
}
