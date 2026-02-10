/**
 * Simple integration test for mint resolution in executor context
 * Verifies that mint labels (USDC/SOL/USDT) work correctly in plan parsing
 */

import { resolveMint } from '../src/utils/mintResolve.js';

console.log('[Test] Mint Resolution Integration Test\n');

// Test scenario: Plan has repayMint as string label
const testPlans = [
  { name: 'USDC label', repayMint: 'USDC', expected: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { name: 'SOL label', repayMint: 'SOL', expected: 'So11111111111111111111111111111111111111112' },
  { name: 'USDT label', repayMint: 'USDT', expected: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { name: 'Base58 address', repayMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', expected: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { name: 'Lowercase label', repayMint: 'usdc', expected: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
];

let passed = 0;
let failed = 0;

console.log('Testing mint resolution in executor context:\n');

for (const plan of testPlans) {
  try {
    // Simulate what executor does
    const repayMintPreference = plan.repayMint ? resolveMint(plan.repayMint) : undefined;
    
    if (!repayMintPreference) {
      console.error(`✗ ${plan.name}: resolveMint returned undefined`);
      failed++;
      continue;
    }
    
    const result = repayMintPreference.toBase58();
    
    if (result === plan.expected) {
      console.log(`✓ ${plan.name}: ${plan.repayMint} → ${result}`);
      passed++;
    } else {
      console.error(`✗ ${plan.name}: Expected ${plan.expected}, got ${result}`);
      failed++;
    }
  } catch (err) {
    console.error(`✗ ${plan.name}: Error - ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// Test error case
console.log('\nTesting error handling:');
const invalidPlan = { repayMint: 'INVALID_MINT' };

try {
  resolveMint(invalidPlan.repayMint);
  console.error('✗ Invalid mint should have thrown error');
  failed++;
} catch (err) {
  if (err instanceof Error && err.message.includes('Invalid mint label or address')) {
    console.log('✓ Invalid mint correctly throws error with helpful message');
    console.log(`  Error message: ${err.message.substring(0, 80)}...`);
    passed++;
  } else {
    console.error(`✗ Wrong error type: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\n=== Results ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.error('\n❌ TEST FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED');
  process.exit(0);
}
