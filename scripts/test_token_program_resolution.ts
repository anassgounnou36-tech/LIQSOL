import { Connection, PublicKey } from "@solana/web3.js";
import { resolveTokenProgramId } from "../src/solana/tokenProgram.js";
import { USDC_MINT } from "../src/constants/mints.js";

(async () => {
  const rpcUrl = process.env.RPC_PRIMARY || "https://api.mainnet-beta.solana.com";
  
  console.log("Testing token program resolution...");
  console.log(`RPC: ${rpcUrl.slice(0, 50)}...`);
  
  const conn = new Connection(rpcUrl, "processed");
  const usdc = new PublicKey(USDC_MINT);
  
  console.log(`\nResolving token program for USDC mint: ${usdc.toBase58()}`);
  
  try {
    const owner = await resolveTokenProgramId(conn, usdc);
    console.log(`✓ Token program: ${owner.toBase58()}`);
    
    // Test cache by calling again
    console.log("\nTesting cache (second call should be instant)...");
    const owner2 = await resolveTokenProgramId(conn, usdc);
    console.log(`✓ Token program (cached): ${owner2.toBase58()}`);
    
    if (owner.equals(owner2)) {
      console.log("\n✓ SUCCESS: Token program resolution working correctly");
      process.exit(0);
    } else {
      console.error("\n✗ FAILURE: Cached result differs from first call");
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n✗ FAILURE: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
})();
