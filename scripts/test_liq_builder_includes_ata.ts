import { Connection, PublicKey } from "@solana/web3.js";
import { loadEnv } from "../src/config/env.js";
import { buildKaminoLiquidationIxs } from "../src/kamino/liquidationBuilder.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Test that liquidation builder properly separates ATA create instructions
 * TX Size Fix: ATAs should be in setupIxs, not refreshIxs
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
    console.log(`  Setup ixs: ${result.setupIxs.length}`);
    console.log(`  Refresh ixs: ${result.refreshIxs.length}`);
    console.log(`  Liquidation ixs: ${result.liquidationIxs.length}`);
    console.log(`  Repay mint: ${result.repayMint.toBase58()}`);
    console.log(`  Collateral mint: ${result.collateralMint.toBase58()}`);

    // TX Size Fix: Check that ATAs are in setupIxs, NOT in refreshIxs
    // ATA create instructions use the Associated Token Program
    const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    
    const ataInSetup = result.setupIxs.filter(
      ix => ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID
    );
    
    const ataInRefresh = result.refreshIxs.filter(
      ix => ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Verify ATAs are NOT in refreshIxs (the fix)
    if (ataInRefresh.length > 0) {
      console.error(`\n✗ FAILURE: Found ${ataInRefresh.length} ATA instructions in refreshIxs`);
      console.error("  ATAs should be in setupIxs to keep liquidation TX small");
      process.exit(1);
    }

    console.log(`\n✓ Verification passed: refreshIxs contains NO ATA instructions`);
    
    // Verify setupIxs structure (may be empty if all ATAs exist)
    if (result.setupIxs.length === 0) {
      console.log(`\n✓ All ATAs already exist (no setup needed)`);
      console.log("  This is expected when running test multiple times");
      console.log("✓ SUCCESS: ATA separation working correctly!");
      process.exit(0);
    } else if (ataInSetup.length > 0) {
      console.log(`\n✓ Found ${ataInSetup.length} ATA instructions in setupIxs`);
      console.log("  Expected: up to 3 (repay, collateral, withdrawLiq)");
      console.log("✓ SUCCESS: ATAs properly separated into setup transaction!");
      process.exit(0);
    } else {
      console.error(`\n✗ FAILURE: Setup contains non-ATA instructions`);
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
