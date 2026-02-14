import { Connection, PublicKey } from "@solana/web3.js";
import { loadEnv } from "../src/config/env.js";
import { buildKaminoLiquidationIxs } from "../src/kamino/liquidationBuilder.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Test that liquidation builder properly separates ATA setup instructions
 * from the main liquidation flow to reduce transaction size
 */
(async () => {
  loadEnv();

  const rpcUrl = process.env.RPC_PRIMARY;
  if (!rpcUrl) {
    console.error("ERROR: RPC_PRIMARY not set");
    process.exit(1);
  }

  const marketStr = process.env.KAMINO_MARKET_PUBKEY;
  const programIdStr = process.env.KAMINO_KLEND_PROGRAM_ID;
  const liquidatorStr = process.env.BOT_KEYPAIR_PATH;

  if (!marketStr || !programIdStr) {
    console.error("ERROR: Required env vars not set (KAMINO_MARKET_PUBKEY, KAMINO_KLEND_PROGRAM_ID)");
    process.exit(1);
  }

  // Get liquidator pubkey from keypair file
  let liquidatorPubkey: PublicKey;
  if (liquidatorStr && fs.existsSync(liquidatorStr)) {
    const secret = JSON.parse(fs.readFileSync(liquidatorStr, "utf8"));
    const keypair = await import("@solana/web3.js").then(m => m.Keypair.fromSecretKey(Uint8Array.from(secret)));
    liquidatorPubkey = keypair.publicKey;
  } else {
    console.error("ERROR: BOT_KEYPAIR_PATH not set or file not found");
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

  console.log("Testing ATA setup separation in liquidation builder...");
  console.log(`Market: ${marketStr}`);
  console.log(`Program: ${programIdStr}`);
  console.log(`Liquidator: ${liquidatorPubkey.toBase58()}`);
  console.log(`Obligation: ${obligationStr}`);

  const conn = new Connection(rpcUrl, "processed");

  try {
    const result = await buildKaminoLiquidationIxs({
      connection: conn,
      marketPubkey: new PublicKey(marketStr),
      programId: new PublicKey(programIdStr),
      obligationPubkey: new PublicKey(obligationStr),
      liquidatorPubkey: liquidatorPubkey,
    });

    console.log(`\n✓ Built instructions successfully`);
    console.log(`  Setup ixs: ${result.setupIxs.length}`);
    console.log(`  Refresh ixs: ${result.refreshIxs.length}`);
    console.log(`  Liquidation ixs: ${result.liquidationIxs.length}`);
    console.log(`  Repay mint: ${result.repayMint.toBase58()}`);
    console.log(`  Collateral mint: ${result.collateralMint.toBase58()}`);
    console.log(`  ATA count (metadata): ${result.ataCount}`);

    // Verify that setupIxs contains ATA creates
    const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    const ataInSetup = result.setupIxs.filter(
      ix => ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Verify that refreshIxs does NOT contain ATA creates
    const ataInRefresh = result.refreshIxs.filter(
      ix => ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID
    );

    console.log(`\n✓ Verification:`);
    console.log(`  ATA instructions in setupIxs: ${ataInSetup.length}`);
    console.log(`  ATA instructions in refreshIxs: ${ataInRefresh.length}`);

    if (ataInRefresh.length > 0) {
      console.error(`\n✗ FAILURE: Found ${ataInRefresh.length} ATA instructions in refreshIxs`);
      console.error("  ATAs should only be in setupIxs, not in refreshIxs");
      process.exit(1);
    }

    if (result.setupIxs.length === 0) {
      console.log(`\n✓ SUCCESS: All ATAs already exist, no setup needed`);
      console.log("  This is expected when running the test multiple times");
      console.log("  The first run would have created the ATAs");
    } else if (result.setupIxs.length === ataInSetup.length && ataInSetup.length > 0) {
      console.log(`\n✓ SUCCESS: Setup contains ${ataInSetup.length} ATA create instruction(s)`);
      console.log("  ATAs are properly separated from liquidation transaction");
    } else {
      console.error(`\n✗ FAILURE: Setup contains non-ATA instructions`);
      console.error(`  Setup ixs: ${result.setupIxs.length}, ATA ixs: ${ataInSetup.length}`);
      process.exit(1);
    }

    console.log(`\n✓ SUCCESS: ATA setup separation working correctly!`);
    process.exit(0);
  } catch (err) {
    console.error(`\n✗ FAILURE: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
})();
