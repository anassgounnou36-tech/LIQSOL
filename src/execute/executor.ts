import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';
import { buildKaminoFlashloanIxs } from '../flashloan/kaminoFlashloan.js';

function loadPlans(): any[] {
  const qPath = path.join(process.cwd(), 'data', 'tx_queue.json');
  const pPath = path.join(process.cwd(), 'data', 'plans.forecast.json');
  if (fs.existsSync(qPath)) return JSON.parse(fs.readFileSync(qPath, 'utf8'));
  if (fs.existsSync(pPath)) return JSON.parse(fs.readFileSync(pPath, 'utf8'));
  return [];
}

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

(async () => {
  const dry = process.argv.includes('--dryrun');
  const rpcUrl = process.env.RPC_PRIMARY || 'https://api.mainnet-beta.solana.com';
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
    .filter(p => Number(p.ttlMin ?? Infinity) > 0 && Number(p.ttlMin ?? Infinity) <= maxTtlMin)
    .sort((a, b) => (Number(b.ev) - Number(a.ev)) || (Number(a.ttlMin) - Number(b.ttlMin)) || (Number(b.hazard) - Number(a.hazard)));

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

  const kpPath = process.env.BOT_KEYPAIR_PATH;
  if (!kpPath || !fs.existsSync(kpPath)) {
    console.error('BOT_KEYPAIR_PATH missing or invalid.');
    return;
  }
  const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
  const signer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const market = new PublicKey(process.env.KAMINO_MARKET_PUBKEY || '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
  const programId = new PublicKey(process.env.KAMINO_KLEND_PROGRAM_ID || 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

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

  const ixs = [kamino.flashBorrowIx /* swapIxs to be inserted here later */, kamino.flashRepayIx];

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
