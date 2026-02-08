import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../observability/logger.js';

export type MintToKeys = Map<string, Set<string>>;
export type KeyToMints = Map<string, Set<string>>;

function loadJson(file: string): any | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build mint→obligation mapping from queue or candidates file.
 * Falls back to USDC + SOL if no assets field is present.
 */
export function buildMintObligationMapping(): { mintToKeys: MintToKeys; keyToMints: KeyToMints } {
  const mintToKeys: MintToKeys = new Map();
  const keyToMints: KeyToMints = new Map();

  const queuePath = path.join(process.cwd(), 'data', 'tx_queue.json');
  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');

  const queue = loadJson(queuePath);
  const candidates = queue ? null : loadJson(candidatesPath);
  const sourceArray: any[] = Array.isArray(queue)
    ? queue
    : Array.isArray(queue?.data)
    ? queue.data
    : Array.isArray(candidates?.candidates)
    ? candidates.candidates
    : Array.isArray(candidates)
    ? candidates
    : [];

  if (!sourceArray || sourceArray.length === 0) {
    logger.warn('No mapping source found: expected data/tx_queue.json or data/candidates.json');
    return { mintToKeys, keyToMints };
  }

  logger.debug({ source: queue ? 'tx_queue.json' : 'candidates.json', count: sourceArray.length }, 'Building mint→obligation mapping');

  for (const item of sourceArray) {
    const key = String(item.key ?? item.obligationPubkey ?? '');
    if (!key) continue;

    // Extract assets from item, fallback to USDC + SOL
    const assets: string[] =
      Array.isArray(item.assets) && item.assets.length > 0
        ? item.assets
        : [
            // Fallback allowlist scope: USDC + SOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'So11111111111111111111111111111111111111112',
          ];

    for (const mint of assets) {
      if (!mintToKeys.has(mint)) mintToKeys.set(mint, new Set());
      mintToKeys.get(mint)!.add(key);
      if (!keyToMints.has(key)) keyToMints.set(key, new Set());
      keyToMints.get(key)!.add(mint);
    }
  }

  logger.info({ uniqueMints: mintToKeys.size, totalObligations: keyToMints.size }, 'Mint→obligation mapping built');

  return { mintToKeys, keyToMints };
}

/**
 * Update mapping when a plan changes (e.g., assets modified).
 * Removes old mappings and adds new ones.
 */
export function updateMappingOnPlanChange(
  keyToMints: KeyToMints,
  mintToKeys: MintToKeys,
  key: string,
  newMints: string[]
): void {
  // Remove old mappings
  const old = keyToMints.get(key) ?? new Set<string>();
  for (const m of old) {
    const set = mintToKeys.get(m);
    if (set) {
      set.delete(key);
      if (set.size === 0) mintToKeys.delete(m);
    }
  }

  // Add new mappings
  const nm = new Set(newMints);
  keyToMints.set(key, nm);
  for (const m of nm) {
    if (!mintToKeys.has(m)) mintToKeys.set(m, new Set());
    mintToKeys.get(m)!.add(key);
  }

  logger.debug({ key, oldMints: Array.from(old), newMints }, 'Updated mint→obligation mapping for key');
}
