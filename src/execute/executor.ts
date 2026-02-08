import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, VersionedTransaction, TransactionMessage, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildKaminoFlashloanIxs } from '../flashloan/kaminoFlashloan.js';
import { buildJupiterSwapIxs } from './swapBuilder.js';
import { checkSolBalance, checkATAExists, validateInstructions } from './preflight.js';
import { loadEnv } from '../config/env.js';

interface Plan {
  key: string;
  mint?: string;
  amountUi?: string;
  amountUsd?: string;
  ev?: number | string;
  hazard?: number | string;
  ttlStr?: string;
  ttlMin?: number | string;
  createdAtMs?: number | string;
}

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

function loadPlans(): Plan[] {
  const qPath = path.join(process.cwd(), 'data', 'tx_queue.json');
  const pPath = path.join(process.cwd(), 'data', 'plans.forecast.json');
  if (fs.existsSync(qPath)) return JSON.parse(fs.readFileSync(qPath, 'utf8')) as Plan[];
  if (fs.existsSync(pPath)) return JSON.parse(fs.readFileSync(pPath, 'utf8')) as Plan[];
  return [];
}

export interface ExecutorOptions {
  dry?: boolean;
}

export interface ExecutorResult {
  status: string;
  plan?: Plan;
  simulation?: unknown;
}

export async function runDryExecutor(opts: ExecutorOptions = {}): Promise<ExecutorResult> {
  const env = loadEnv();
  const dry = opts.dry ?? true;
  const rpcUrl = env.RPC_PRIMARY || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const minEv = getEnvNum('EXEC_MIN_EV', 0);
  const maxTtlMin = getEnvNum('EXEC_MAX_TTL_MIN', 10);
  const minDelayMs = getEnvNum('SCHEDULED_MIN_LIQUIDATION_DELAY_MS', 0);

  const plans = loadPlans();
  if (!Array.isArray(plans) || plans.length === 0) {
    console.log('No plans available. Ensure data/tx_queue.json exists (PR10/PR11).');
    return { status: 'no_plans' };
  }

  const candidates = plans
    .filter(p => Number(p.ev ?? 0) > minEv)
    .filter(p => Number(p.ttlMin ?? Infinity) > 0 && Number(p.ttlMin ?? Infinity) <= maxTtlMin)
    .sort((a, b) => (Number(b.ev) - Number(a.ev)) || (Number(a.ttlMin) - Number(b.ttlMin)) || (Number(b.hazard) - Number(a.hazard)));

  if (candidates.length === 0) {
    console.log('No eligible candidates based on EV/TTL thresholds.');
    return { status: 'no_candidates' };
  }

  const target = candidates[0];
  const now = Date.now();
  const createdAtMs = Number(target.createdAtMs ?? 0);
  const ageMs = createdAtMs ? (now - createdAtMs) : Infinity;
  if (minDelayMs > 0 && ageMs < minDelayMs) {
    console.log(`Skipping due to SCHEDULED_MIN_LIQUIDATION_DELAY_MS (${minDelayMs}ms). Age: ${ageMs}ms`);
    return { status: 'delayed', plan: target };
  }

  const kpPath = env.BOT_KEYPAIR_PATH;
  if (!kpPath || !fs.existsSync(kpPath)) {
    console.error('BOT_KEYPAIR_PATH missing or invalid.');
    return { status: 'keypair_missing' };
  }
  const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
  const signer = Keypair.fromSecretKey(Uint8Array.from(secret));

  // Preflight: SOL fee buffer (e.g., ~0.01 SOL)
  const minLamports = Math.floor(0.01 * 1e9);
  const okSol = await checkSolBalance(connection, signer.publicKey, minLamports);
  if (!okSol) {
    console.error(`Insufficient SOL balance. Need >= ${minLamports} lamports.`);
    return { status: 'insufficient_sol' };
  }

  // Preflight: ATAs for borrow and repay mints (assume USDC repay for now)
  const borrowMintStr = target.mint || 'USDC';
  const repayMintStr = 'USDC'; // Future PR: derive from market state
  const borrowMint = new PublicKey(borrowMintStr === 'USDC' ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : 'So11111111111111111111111111111111111111112');
  const repayMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

  const borrowAtaCheck = await checkATAExists(connection, signer.publicKey, borrowMint);
  const repayAtaCheck = await checkATAExists(connection, signer.publicKey, repayMint);
  if (!borrowAtaCheck.exists) console.warn(`Borrow ATA missing: ${borrowAtaCheck.ata.toBase58()} (dry-run continues)`);
  if (!repayAtaCheck.exists) console.warn(`Repay ATA missing: ${repayAtaCheck.ata.toBase58()} (dry-run continues)`);

  // Kamino flashloan instructions
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

  // Build swap if tokens differ (e.g., SOL → USDC)
  let swapIxs: TransactionInstruction[] = [];
  const needSwap = borrowMintStr !== repayMintStr;
  if (needSwap) {
    try {
      const fromDecimals = borrowMintStr === 'USDC' ? 6 : 9; // Simplified; future PR: fetch mint decimals dynamically
      swapIxs = await buildJupiterSwapIxs({
        userPublicKey: signer.publicKey,
        fromMint: borrowMint.toBase58(),
        toMint: repayMint.toBase58(),
        amountUi,
        fromDecimals,
        slippageBps: 50,
      });
      if (!validateInstructions(swapIxs)) {
        console.warn('Swap instructions invalid or empty; proceeding without swap.');
        swapIxs = [];
      }
    } catch (e) {
      console.warn(`Swap builder failed: ${(e as Error).message}. Proceeding without swap.`);
      swapIxs = [];
    }
  }

  const ixs = [kamino.flashBorrowIx, ...swapIxs, kamino.flashRepayIx];

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
    return { status: 'simulated', plan: target, simulation: sim };
  } else {
    console.log('Dry-run only mode; no broadcast.');
    return { status: 'dry_only', plan: target };
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const dry = process.argv.includes('--dryrun');
    await runDryExecutor({ dry });
  })();
}
