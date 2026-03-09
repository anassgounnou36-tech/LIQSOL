import { Buffer } from 'node:buffer';
import type { VersionedTransaction } from '@solana/web3.js';

export interface JitoSendResult {
  signature: string;
  bundleId?: string;
}

let cachedTipAccounts: string[] | undefined;
let cachedTipAccountsUntilMs = 0;

function getTipAccountCacheMs(): number {
  return Math.max(0, Number(process.env.JITO_TIP_ACCOUNT_CACHE_MS ?? 300000));
}

export async function fetchJitoTipAccounts(args: {
  bundlesUrl: string;
}): Promise<string[]> {
  const nowMs = Date.now();
  if (cachedTipAccounts && nowMs < cachedTipAccountsUntilMs) {
    return cachedTipAccounts;
  }

  const response = await fetch(args.bundlesUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTipAccounts',
      params: [],
    }),
  });
  if (!response.ok) {
    throw new Error(`Jito getTipAccounts failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as { result?: unknown };
  if (!Array.isArray(payload.result)) {
    throw new Error('Jito getTipAccounts response missing result array');
  }
  const tipAccounts = payload.result.filter((entry): entry is string => typeof entry === 'string');
  cachedTipAccounts = tipAccounts;
  cachedTipAccountsUntilMs = nowMs + getTipAccountCacheMs();
  return tipAccounts;
}

export async function sendTransactionViaJito(args: {
  tx: VersionedTransaction;
  txUrl: string;
  bundleOnly: boolean;
}): Promise<JitoSendResult> {
  const serializedTx = Buffer.from(args.tx.serialize()).toString('base64');
  const response = await fetch(args.txUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [
        serializedTx,
        {
          encoding: 'base64',
          bundleOnly: args.bundleOnly,
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Jito sendTransaction failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as {
    result?: string | { signature?: string; bundleId?: string };
    error?: { message?: string };
  };
  if (payload.error) {
    throw new Error(`Jito sendTransaction error: ${payload.error.message ?? 'unknown'}`);
  }

  const headerBundleId = response.headers.get('x-bundle-id') ?? undefined;
  if (typeof payload.result === 'string') {
    return { signature: payload.result, bundleId: headerBundleId };
  }
  if (payload.result && typeof payload.result === 'object' && typeof payload.result.signature === 'string') {
    return {
      signature: payload.result.signature,
      bundleId: payload.result.bundleId ?? headerBundleId,
    };
  }
  throw new Error('Jito sendTransaction response missing signature');
}
