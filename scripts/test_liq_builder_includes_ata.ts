import { Connection, PublicKey } from "@solana/web3.js";
import { loadEnv } from "../src/config/env.js";
import { buildKaminoLiquidationIxs } from "../src/kamino/liquidationBuilder.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Test that liquidation builder includes ATA create instructions in refreshIxs
 */
(async () => {
  loadEnv();

  const rpcUrl = process.env.RPC_PRIMARY;
  if (!rpcUrl) {
    console.error("ERROR: RPC_PRIMARY not set");
    process.exit(1);
  }

  const marketStr = process.env.KAMINO_MARKET;
  const programIdStr = process.env.KAMINO_PROGRAM_ID;
  const liquidatorStr = process.env.LIQUIDATOR_PUBKEY;

  if (!marketStr || !programIdStr || !liquidatorStr) {
    console.error("ERROR: Required env vars not set (KAMINO_MARKET, KAMINO_PROGRAM_ID, LIQUIDATOR_PUBKEY)");
    process.exit(1);
  }

  // Try to load an obligation from candidates or use a default test one
  let obligationStr: string | undefined;

  const candidatesPath = path.join(process.cwd(), "data", "candidates.scored.json");
  if (fs.existsSync(candidatesPath)) {
    const candidates = JSON.parse(fs.readFileSync(candidatesPath, "utf8"));
    const candidatesList = Array.isArray(candidates) ? candidates : 
                          candidates.data ? candidates.data : 
                          candidates.candidates ? candidates.candidates : 
                          Object.values(candidates);
    
    if (candidatesList.length > 0) {
      obligationStr = candidatesList[0].obligationPubkey || candidatesList[0].obligation;
    }
  }

  if (!obligationStr) {
    console.error("ERROR: No obligation found in candidates.scored.json");
    console.error("Please run: npm run snapshot:candidates");
    process.exit(1);
  }

  console.log("Testing liquidation builder includes ATA create instructions...");
  console.log(`Market: ${marketStr}`);
  console.log(`Program: ${programIdStr}`);
  console.log(`Liquidator: ${liquidatorStr}`);
  console.log(`Obligation: ${obligationStr}`);

  const conn = new Connection(rpcUrl, "processed");

  try {
    const result = await buildKaminoLiquidationIxs({
      connection: conn,
      marketPubkey: new PublicKey(marketStr),
      programId: new PublicKey(programIdStr),
      obligationPubkey: new PublicKey(obligationStr),
      liquidatorPubkey: new PublicKey(liquidatorStr),
    });

    console.log(`\n✓ Built instructions successfully`);
    console.log(`  Refresh ixs: ${result.refreshIxs.length}`);
    console.log(`  Liquidation ixs: ${result.liquidationIxs.length}`);
    console.log(`  Repay mint: ${result.repayMint.toBase58()}`);
    console.log(`  Collateral mint: ${result.collateralMint.toBase58()}`);

    // Check if refreshIxs includes ATA create instructions
    // ATA create instructions use the Associated Token Program
    const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    const ataInstructions = result.refreshIxs.filter(
      ix => ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID
    );

    if (ataInstructions.length >= 3) {
      console.log(`\n✓ SUCCESS: Found ${ataInstructions.length} ATA create instructions in refreshIxs`);
      console.log("  Expected: 3 (source liquidity, destination collateral, destination liquidity)");
      process.exit(0);
    } else {
      console.error(`\n✗ FAILURE: Expected at least 3 ATA create instructions, found ${ataInstructions.length}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n✗ FAILURE: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
})();
