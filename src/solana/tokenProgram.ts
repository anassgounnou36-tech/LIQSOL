import { Connection, PublicKey } from "@solana/web3.js";

const TOKEN_PROGRAM_CACHE = new Map<string, PublicKey>();

/**
 * Resolve token program id for a mint by reading its account owner.
 * Caches results per mint.
 */
export async function resolveTokenProgramId(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const key = mint.toBase58();
  const cached = TOKEN_PROGRAM_CACHE.get(key);
  if (cached) return cached;

  const ai = await connection.getAccountInfo(mint, "processed");
  if (!ai) throw new Error(`Mint account not found: ${key}`);

  TOKEN_PROGRAM_CACHE.set(key, ai.owner);
  return ai.owner;
}
