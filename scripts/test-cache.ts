import { Connection, PublicKey } from "@solana/web3.js";
import { loadMarketCaches } from "../src/cache/index.js";

async function main() {
  // Use public Solana RPC
  const connection = new Connection(
    "https://api.mainnet-beta.solana.com",
    "confirmed"
  );

  // Kamino Main Market
  const marketPubkey = new PublicKey(
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
  );

  console.log("Loading market caches...");
  const startTime = Date.now();

  try {
    const caches = await loadMarketCaches(connection, marketPubkey);

    const elapsed = Date.now() - startTime;

    console.log("\n=== CACHE RESULTS ===");
    console.log(`Total reserves: ${caches.reserves.size}`);
    console.log(`Total oracles: ${caches.oracles.size}`);
    console.log(`Time elapsed: ${elapsed}ms`);

    // Show first 3 reserves
    console.log("\n=== SAMPLE RESERVES ===");
    let count = 0;
    for (const [mint, reserve] of caches.reserves.entries()) {
      if (count >= 3) break;
      console.log(`\nMint: ${mint}`);
      console.log(`  Reserve: ${reserve.reservePubkey.toString()}`);
      console.log(`  Available: ${reserve.availableAmount.toString()}`);
      console.log(`  LTV: ${reserve.loanToValue}%`);
      console.log(`  Liq Threshold: ${reserve.liquidationThreshold}%`);
      console.log(`  Oracles: ${reserve.oraclePubkeys.length}`);
      count++;
    }

    // Show first 3 oracles
    console.log("\n=== SAMPLE ORACLES ===");
    count = 0;
    for (const [mint, oracle] of caches.oracles.entries()) {
      if (count >= 3) break;
      console.log(`\nMint: ${mint}`);
      console.log(`  Type: ${oracle.oracleType}`);
      console.log(`  Price: ${oracle.price.toString()}`);
      console.log(`  Confidence: ${oracle.confidence.toString()}`);
      console.log(`  Exponent: ${oracle.exponent}`);
      count++;
    }

    console.log("\n✅ Cache test completed successfully!");
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
}

main();
