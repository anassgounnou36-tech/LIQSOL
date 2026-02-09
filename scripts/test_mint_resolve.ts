// Test mint resolution
import { resolveMint } from '../src/utils/mintResolve.js';

console.log('Testing mint resolution:\n');

// Test known labels
const tests = [
  { input: 'USDC', expected: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { input: 'SOL', expected: 'So11111111111111111111111111111111111111112' },
  { input: 'USDT', expected: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { input: 'usdc', expected: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, // case insensitive
  { input: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', expected: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, // passthrough
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    const result = resolveMint(test.input);
    const resultStr = result.toBase58();
    if (resultStr === test.expected) {
      console.log(`✓ ${test.input} -> ${resultStr}`);
      passed++;
    } else {
      console.log(`✗ ${test.input} -> ${resultStr} (expected ${test.expected})`);
      failed++;
    }
  } catch (err) {
    console.log(`✗ ${test.input} threw error: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// Test invalid input
console.log('\nTesting invalid inputs:');
const invalidTests = ['INVALID', 'BTC123', 'not-a-pubkey'];

for (const input of invalidTests) {
  try {
    resolveMint(input);
    console.log(`✗ ${input} should have thrown error but didn't`);
    failed++;
  } catch (err) {
    console.log(`✓ ${input} correctly threw error: ${err instanceof Error ? err.message.substring(0, 50) : String(err)}`);
    passed++;
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
