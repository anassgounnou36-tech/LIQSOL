import type { AddressLookupTableAccount, TransactionInstruction } from '@solana/web3.js';
import type { BuiltPlanTx } from './planTxBuilder.js';

export interface ValidationPath {
  pathLabel: 'setup-only' | 'main' | 'atomic';
  instructions: TransactionInstruction[];
  labels: string[];
  lookupTables?: AddressLookupTableAccount[];
}

export function extractValidationPaths(built: BuiltPlanTx): ValidationPath[] {
  const paths: ValidationPath[] = [];
  if (built.setupIxs.length > 0) {
    paths.push({
      pathLabel: 'setup-only',
      instructions: built.setupIxs,
      labels: built.setupLabels,
    });
  }
  if (built.mainIxs.length > 0) {
    paths.push({
      pathLabel: 'main',
      instructions: built.mainIxs,
      labels: built.mainLabels,
    });
  }
  if (built.atomicIxs.length > 0) {
    paths.push({
      pathLabel: 'atomic',
      instructions: built.atomicIxs,
      labels: built.atomicLabels,
      lookupTables: built.atomicLookupTables,
    });
  }
  return paths;
}

export function pickPrimaryValidationPath(paths: ValidationPath[]): ValidationPath | undefined {
  return (
    paths.find((path) => path.pathLabel === 'atomic') ??
    paths.find((path) => path.pathLabel === 'main') ??
    paths.find((path) => path.pathLabel === 'setup-only')
  );
}

export function verifyJitoTipMutation(args: {
  baseInstructionCount: number;
  rpcInstructionCount: number;
  jitoInstructionCount: number;
  tipLamports: number;
  tipAccountsCount: number;
}): { rpcUnchanged: boolean; jitoExpectedDeltaMatches: boolean; tipShouldBeAdded: boolean } {
  const tipShouldBeAdded = args.tipLamports > 0 && args.tipAccountsCount > 0;
  const expectedJitoCount = args.baseInstructionCount + (tipShouldBeAdded ? 1 : 0);
  return {
    rpcUnchanged: args.rpcInstructionCount === args.baseInstructionCount,
    jitoExpectedDeltaMatches: args.jitoInstructionCount === expectedJitoCount,
    tipShouldBeAdded,
  };
}
