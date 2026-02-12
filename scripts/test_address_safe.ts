#!/usr/bin/env tsx

/**
 * Test script to verify addressSafe functionality
 * Validates that invalid addresses are caught with context
 */

import { PublicKey } from '@solana/web3.js';
import { addressSafe } from '../src/solana/addressSafe.js';

console.log('=== Testing addressSafe function ===\n');

// Test 1: Valid PublicKey object
console.log('Test 1: Valid PublicKey object');
try {
  const validPubkey = new PublicKey('11111111111111111111111111111111');
  const result = addressSafe(validPubkey, 'test:validPubkey');
  console.log('✅ Success:', result);
} catch (e) {
  console.error('❌ Failed:', (e as Error).message);
}

// Test 2: Valid string address
console.log('\nTest 2: Valid string address');
try {
  const result = addressSafe('11111111111111111111111111111111', 'test:validString');
  console.log('✅ Success:', result);
} catch (e) {
  console.error('❌ Failed:', (e as Error).message);
}

// Test 3: Invalid short string
console.log('\nTest 3: Invalid short string (should fail with context)');
try {
  const result = addressSafe('invalid', 'repayRefresh:mint');
  console.log('❌ Should have failed but got:', result);
} catch (e) {
  console.log('✅ Correctly caught error:', (e as Error).message);
}

// Test 4: Invalid character string
console.log('\nTest 4: Invalid character in address (should fail with context)');
try {
  const result = addressSafe('invalid_address_with_special_chars!!!', 'liquidate:collateralMint');
  console.log('❌ Should have failed but got:', result);
} catch (e) {
  console.log('✅ Correctly caught error:', (e as Error).message);
}

// Test 5: Null value
console.log('\nTest 5: Null value (should fail with context)');
try {
  const result = addressSafe(null, 'obligationRefresh:obligation');
  console.log('❌ Should have failed but got:', result);
} catch (e) {
  console.log('✅ Correctly caught error:', (e as Error).message);
}

// Test 6: Number value
console.log('\nTest 6: Number value (should fail with context)');
try {
  const result = addressSafe(12345, 'collateralRefresh:reserve');
  console.log('❌ Should have failed but got:', result);
} catch (e) {
  console.log('✅ Correctly caught error:', (e as Error).message);
}

console.log('\n=== All tests completed ===');
