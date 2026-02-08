import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';
import { buildKaminoFlashloanIxs } from '../flashloan/kaminoFlashloan.js';
import { loadEnv } from '../config/env.js';
import { normalizeWslPath } from '../utils/path.js';

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

function loadPlans(): Plan[] {
  const qPath = path.join(process.cwd(), 'data', 'tx_queue.json');
  const pPath = path.join(process.cwd(), 'data', 'plans.forecast.json');
  if (fs.existsSync(qPath)) return JSON.parse(fs.readFileSync(qPath, 'utf8')) as Plan[];
  if (fs.existsSync(pPath)) return JSON.parse(fs.readFileSync(pPath, 'utf8')) as Plan[];
  return [];
}

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

(async () => {
  // Load environment variables from .env
  const env = loadEnv();
  
  const dry = process.argv.includes('--dryrun');
  const rpcUrl = env.RPC_PRIMARY;
  const connection = new Connection(rpcUrl, 'confirmed');

  const minEv = getEnvNum('EXEC_MIN_EV', 0);
  const maxTtlMin = getEnvNum('EXEC_MAX_TTL_MIN', 10);
  const minDelayMs = getEnvNum('SCHEDULED_MIN_LIQUIDATION_DELAY_MS', 0);

  const plans = loadPlans();
  if (!Array.isArray(plans) || plans.length === 0) {
    console.log('No plans available. Ensure data/tx_queue.json exists (PR10/PR11).');
    return;
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
    return;
  }

  const target = candidates[0];
  const now = Date.now();
  const createdAtMs = Number(target.createdAtMs ?? 0);
  const ageMs = createdAtMs ? (now - createdAtMs) : Infinity;
  if (minDelayMs > 0 && ageMs < minDelayMs) {
    console.log(`Skipping due to SCHEDULED_MIN_LIQUIDATION_DELAY_MS (${minDelayMs}ms). Age: ${ageMs}ms`);
    return;
  }

  // Normalize keypair path for WSL compatibility (converts C:\... to /mnt/c/...)
  const kpPath = normalizeWslPath(env.BOT_KEYPAIR_PATH);
  if (!fs.existsSync(kpPath)) {
    console.error(`BOT_KEYPAIR_PATH does not exist: ${kpPath}`);
    console.error(`Original path from env: ${env.BOT_KEYPAIR_PATH}`);
    return;
  }
  const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
  const signer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const market = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  const programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID);

  const mintValue = target.mint || 'USDC';
  if (mintValue !== 'USDC' && mintValue !== 'SOL') {
    console.error(`Unsupported mint: ${mintValue}. Must be 'USDC' or 'SOL'.`);
    return;
  }
  const mint = mintValue as 'USDC' | 'SOL';
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

  // TODO(PR13+): Insert swap instructions between borrow and repay using buildSwapIxs from swapBuilder.ts
  const ixs = [kamino.flashBorrowIx, kamino.flashRepayIx];

  if (dry) {
    const bh = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: ixs,
    }).compileToLegacyMessage();
    const tx = new VersionedTransaction(msg);
    tx.sign([signer]);
    const sim = await connection.simulateTransaction(tx);
    console.log('Dry-run simulate result:', sim);
  } else {
    console.log('Dry-run only mode; no broadcast.');
  }
})();
