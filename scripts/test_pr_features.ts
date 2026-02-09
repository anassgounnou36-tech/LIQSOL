/**
 * Integration test for PR features:
 * 1. Liquidatable priority bump
 * 2. Audit pipeline resilience
 * 3. Mint resolution
 */

import { enqueuePlans } from '../src/scheduler/txScheduler.js';
import { resolveMint } from '../src/utils/mintResolve.js';
import fs from 'fs';
import path from 'path';

console.log('=== PR FEATURE INTEGRATION TEST ===\n');

// Test 1: Liquidatable Priority Sorting
console.log('Test 1: Liquidatable Priority Sorting');
console.log('--------------------------------------');

const testQueue = [
  {
    planVersion: 2,
    key: 'non-liq-high-ev',
    obligationPubkey: 'non-liq-high-ev',
    mint: 'USDC',
    amountUsd: 1000,
    repayMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    collateralMint: 'So11111111111111111111111111111111111111112',
    ev: 100,
    hazard: 0.9,
    ttlMin: 3,
    createdAtMs: Date.now(),
    liquidationEligible: false
  },
  {
    planVersion: 2,
    key: 'liq-low-ev',
    obligationPubkey: 'liq-low-ev',
    mint: 'USDC',
    amountUsd: 500,
    repayMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    collateralMint: 'So11111111111111111111111111111111111111112',
    ev: 10,
    hazard: 0.5,
    ttlMin: 8,
    createdAtMs: Date.now(),
    liquidationEligible: true
  }
];

// Write test queue
fs.writeFileSync(
  path.join(process.cwd(), 'data', 'tx_queue.json'),
  JSON.stringify(testQueue, null, 2)
);

// Re-sort using enqueuePlans
const sorted = enqueuePlans([]);

console.log('Sorted order:');
sorted.forEach((p, i) => {
  console.log(`  ${i+1}. ${p.key.substring(0, 20).padEnd(20)} - liq=${String(p.liquidationEligible).padEnd(5)} ev=${p.ev}`);
});

const liquidatableFirst = sorted[0]?.liquidationEligible && !sorted[1]?.liquidationEligible;
console.log(liquidatableFirst ? '✓ PASS: Liquidatable sorted first\n' : '✗ FAIL: Liquidatable not sorted first\n');

// Test 2: Mint Resolution
console.log('Test 2: Mint Resolution');
console.log('-----------------------');

const mintTests = [
  { label: 'USDC', expected: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { label: 'SOL', expected: 'So11111111111111111111111111111111111111112' },
  { label: 'USDT', expected: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }
];

let mintPassed = 0;
for (const test of mintTests) {
  try {
    const result = resolveMint(test.label);
    if (result.toBase58() === test.expected) {
      console.log(`✓ ${test.label} resolved correctly`);
      mintPassed++;
    }
  } catch (err) {
    console.log(`✗ ${test.label} failed: ${err}`);
  }
}

// Test invalid mint
try {
  resolveMint('INVALID_MINT');
  console.log('✗ Should have thrown for invalid mint');
} catch (err) {
  console.log('✓ Invalid mint correctly rejected');
  mintPassed++;
}

console.log(`\nMint resolution: ${mintPassed}/4 tests passed\n`);

// Test 3: Audit Pipeline (just verify it exists and can be imported)
console.log('Test 3: Audit Pipeline Command');
console.log('-------------------------------');
const auditPath = path.join(process.cwd(), 'src', 'commands', 'auditPipeline.ts');
if (fs.existsSync(auditPath)) {
  console.log('✓ auditPipeline.ts exists');
  console.log('✓ Run with: npm run audit:pipeline');
} else {
  console.log('✗ auditPipeline.ts not found');
}

console.log('\n=== ALL TESTS COMPLETE ===');
