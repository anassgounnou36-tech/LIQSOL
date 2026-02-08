import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';
import { buildKaminoFlashloanIxs } from '../flashloan/kaminoFlashloan.js';
import { loadEnv } from '../config/env.js';
import { normalizeWslPath } from '../utils/path.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';

interface Plan {
  planVersion?: number;
  key: string;
  obligationPubkey?: string;
  mint?: string;
  amountUi?: string;
  amountUsd?: string;
  ev?: number | string;
  hazard?: number | string;
  ttlStr?: string;
  ttlMin?: number | string;
  createdAtMs?: number | string;
  repayMint?: string;
  collateralMint?: string;
}

/**
 * PR2: Validate plan has required fields and correct version
 * Fail-fast with clear error message if plan is outdated or incomplete
 */
function validatePlanVersion(plan: Plan): asserts plan is FlashloanPlan {
  const planVersion = plan.planVersion ?? 0;
  
  if (planVersion < 2) {
    throw new Error(
      `ERROR: Plan version ${planVersion} is outdated (expected >= 2). ` +
      `Please regenerate tx_queue.json with the latest scheduler. ` +
      `Run: npm run snapshot:candidates to create fresh plans.`
    );
  }
  
  // Validate required PR2 fields
  const missingFields: string[] = [];
  if (!plan.obligationPubkey) missingFields.push('obligationPubkey');
  if (!plan.repayMint) missingFields.push('repayMint');
  if (!plan.collateralMint) missingFields.push('collateralMint');
  
  if (missingFields.length > 0) {
    throw new Error(
      `ERROR: Plan is missing required liquidation fields: ${missingFields.join(', ')}. ` +
      `Please regenerate tx_queue.json with the latest scheduler. ` +
      `Run: npm run snapshot:candidates to create fresh plans.`
    );
  }
}

function loadPlans(): Plan[] {
  const qPath = path.join(process.cwd(), 'data', 'tx_queue.json');
  const pPath = path.join(process.cwd(), 'data', 'plans.forecast.json');
  if (fs.existsSync(qPath)) return JSON.parse(fs.readFileSync(qPath, 'utf8')) as Plan[];
  if (fs.existsSync(pPath)) return JSON.parse(fs.readFileSync(pPath, 'utf8')) as Plan[];
  return [];
}

// Exported API for scheduler
export async function runDryExecutor(opts?: { dry?: boolean }): Promise<{ status: string } | void> {
  // Load env early to ensure .env variables exist under WSL
  const env = loadEnv();
  const dry = opts?.dry ?? true;

  const rpcUrl = env.RPC_PRIMARY || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const minEv = Number(env.EXEC_MIN_EV ?? 0);
  const maxTtlMin = Number(env.EXEC_MAX_TTL_MIN ?? 10);
  const minDelayMs = Number(env.SCHEDULED_MIN_LIQUIDATION_DELAY_MS ?? 0);

  const plans = loadPlans();
  if (!Array.isArray(plans) || plans.length === 0) {
    console.log('No plans available. Ensure data/tx_queue.json exists (PR10/PR11).');
    return { status: 'no-plans' };
  }

  const candidates = plans
    .filter(p => Number(p.ev ?? 0) > minEv)
    .filter(p => {
      const ttl = Number(p.ttlMin ?? Infinity);
      return ttl > 0 && ttl <= maxTtlMin;
    })
    .sort((a, b) => {
      const evDiff = Number(b.ev ?? 0) - Number(a.ev ?? 0);
      if (evDiff !== 0) return evDiff;
      const ttlDiff = Number(a.ttlMin ?? Infinity) - Number(b.ttlMin ?? Infinity);
      if (ttlDiff !== 0) return ttlDiff;
      return Number(b.hazard ?? 0) - Number(a.hazard ?? 0);
    });

  if (candidates.length === 0) {
    console.log('No eligible candidates based on EV/TTL thresholds.');
    return { status: 'no-eligible' };
  }

  const target = candidates[0];
  
  // PR2: Validate plan version and required fields
  try {
    validatePlanVersion(target);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { status: 'invalid-plan' };
  }
  
  const now = Date.now();
  const createdAtMs = Number(target.createdAtMs ?? 0);
  const ageMs = createdAtMs ? (now - createdAtMs) : Infinity;
  if (minDelayMs > 0 && ageMs < minDelayMs) {
    console.log(`Skipping due to SCHEDULED_MIN_LIQUIDATION_DELAY_MS (${minDelayMs}ms). Age: ${ageMs}ms`);
    return { status: 'min-delay' };
  }

  const kpPath = normalizeWslPath(env.BOT_KEYPAIR_PATH);
  if (!kpPath || !fs.existsSync(kpPath)) {
    console.error(`Keypair not found at ${kpPath}.`);
    return { status: 'no-keypair' };
  }
  const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
  const signer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const market = new PublicKey(env.KAMINO_MARKET_PUBKEY || '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
  const programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID || 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

  const mint = (target.mint || 'USDC') as 'USDC' | 'SOL';
  const amountUi = String(target.amountUi ?? target.amountUsd ?? '100');

  const kamino = await buildKaminoFlashloanIxs({
    connection,
    marketPubkey: market,
    programId,
    signer,
    mint,
    amountUi,
    borrowIxIndex: 0,
  });

  const ixs = [kamino.flashBorrowIx, kamino.flashRepayIx];

  const bh = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: bh.blockhash,
    instructions: ixs,
  }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  tx.sign([signer]);

  if (dry) {
    const sim = await connection.simulateTransaction(tx);
    console.log('Dry-run simulate result:', sim);
    return { status: 'simulated' };
  } else {
    console.log('Dry-run only mode; no broadcast.');
    return { status: 'no-broadcast' };
  }
}

// Preserve CLI behavior (standalone run)
(async () => {
  if (process.argv.includes('--dryrun')) {
    await runDryExecutor({ dry: true });
  }
})();
