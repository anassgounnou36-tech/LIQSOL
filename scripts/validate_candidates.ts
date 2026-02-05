/**
 * PR8 Candidate Validator
 * 
 * Validates the structure and integrity of data/candidates.json
 * - Checks file exists
 * - Validates candidate structure and numeric fields
 * - Ensures candidates are sorted by priorityScore descending
 * - Verifies no NaN/Infinity values in key fields
 */

import fs from "fs";

const CANDIDATES_FILE = "data/candidates.json";

function main() {
  console.log("PR8 Candidate Validator");
  console.log("========================\n");

  // Check file exists
  if (!fs.existsSync(CANDIDATES_FILE)) {
    throw new Error(`ERROR: ${CANDIDATES_FILE} not found. Run snapshot:candidates first.`);
  }
  console.log(`✓ File exists: ${CANDIDATES_FILE}`);

  // Read and parse JSON
  const content = fs.readFileSync(CANDIDATES_FILE, "utf-8");
  let data;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`ERROR: Failed to parse JSON: ${err}`);
  }
  console.log("✓ Valid JSON structure");

  // Check candidates array
  const candidates = data?.candidates;
  if (!Array.isArray(candidates)) {
    throw new Error("ERROR: 'candidates' field is missing or not an array");
  }
  console.log(`✓ Candidates array found with ${candidates.length} entries`);

  if (candidates.length === 0) {
    throw new Error("ERROR: No candidates found in array");
  }

  // Validate each candidate
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    
    // Check required fields exist
    const requiredFields = [
      "obligationPubkey",
      "ownerPubkey",
      "healthRatio",
      "liquidationEligible",
      "borrowValueUsd",
      "collateralValueUsd",
      "priorityScore",
      "distanceToLiquidation",
      "predictedLiquidatableSoon",
    ];
    
    for (const field of requiredFields) {
      if (!(field in c)) {
        throw new Error(`ERROR: Candidate ${i} missing required field: ${field}`);
      }
    }
    
    // Check numeric fields are finite
    const numericFields = [
      "healthRatio",
      "borrowValueUsd",
      "collateralValueUsd",
      "priorityScore",
      "distanceToLiquidation",
    ];
    
    for (const field of numericFields) {
      const value = c[field];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `ERROR: Candidate ${i} (${c.obligationPubkey}): ${field} is not a finite number (value: ${value})`
        );
      }
    }
    
    // Check boolean fields
    if (typeof c.liquidationEligible !== "boolean") {
      throw new Error(
        `ERROR: Candidate ${i} (${c.obligationPubkey}): liquidationEligible is not a boolean`
      );
    }
    
    if (typeof c.predictedLiquidatableSoon !== "boolean") {
      throw new Error(
        `ERROR: Candidate ${i} (${c.obligationPubkey}): predictedLiquidatableSoon is not a boolean`
      );
    }
  }
  console.log("✓ All candidates have valid structure and numeric fields");

  // Verify sorting by priorityScore descending
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].priorityScore > candidates[i - 1].priorityScore) {
      throw new Error(
        `ERROR: Candidates not sorted by priorityScore descending at index ${i}:\n` +
        `  [${i - 1}] priorityScore: ${candidates[i - 1].priorityScore}\n` +
        `  [${i}] priorityScore: ${candidates[i].priorityScore}`
      );
    }
  }
  console.log("✓ Candidates sorted by priorityScore descending");

  // Validate selection rules
  const liquidatableCount = candidates.filter((c) => c.liquidationEligible).length;
  const nearThresholdCount = candidates.filter((c) => c.predictedLiquidatableSoon).length;
  
  console.log(`\nCandidate Statistics:`);
  console.log(`  Total candidates: ${candidates.length}`);
  console.log(`  Liquidatable: ${liquidatableCount}`);
  console.log(`  Near threshold (predicted soon): ${nearThresholdCount}`);
  console.log(`  Average health ratio: ${(candidates.reduce((sum, c) => sum + c.healthRatio, 0) / candidates.length).toFixed(4)}`);
  console.log(`  Average priority score: ${(candidates.reduce((sum, c) => sum + c.priorityScore, 0) / candidates.length).toFixed(2)}`);

  // Verify liquidatable accounts have highest priority
  const firstNonLiquidatable = candidates.findIndex((c) => !c.liquidationEligible);
  if (firstNonLiquidatable > 0) {
    const lastLiquidatable = candidates[firstNonLiquidatable - 1];
    const firstNonLiq = candidates[firstNonLiquidatable];
    
    if (firstNonLiq.priorityScore >= lastLiquidatable.priorityScore) {
      throw new Error(
        `ERROR: Non-liquidatable candidate has higher priority than liquidatable:\n` +
        `  Last liquidatable [${firstNonLiquidatable - 1}]: priority=${lastLiquidatable.priorityScore}\n` +
        `  First non-liquidatable [${firstNonLiquidatable}]: priority=${firstNonLiq.priorityScore}`
      );
    }
  }
  console.log("✓ Liquidatable candidates prioritized correctly");

  console.log("\n✅ PR8 candidates validated successfully!");
}

try {
  main();
} catch (err) {
  console.error("\n" + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
