/**
 * Test script for Kamino KLend error decoder
 * 
 * Validates that error codes are properly decoded into readable messages.
 * Specifically tests Custom(6006) and other common errors.
 */

import { decodeKlendError, getKlendErrorName, getKlendErrorMsg, isKnownKlendError } from '../src/kamino/errors.js';

interface TestCase {
  code: number;
  expectedName: string;
  expectedMsgContains: string;
}

const testCases: TestCase[] = [
  // Primary focus: Custom(6006)
  { code: 6006, expectedName: 'InvalidAccountInput', expectedMsgContains: 'Invalid account input' },
  
  // Common liquidation-related errors
  { code: 6016, expectedName: 'ObligationHealthy', expectedMsgContains: 'Cannot liquidate healthy obligations' },
  { code: 6017, expectedName: 'ObligationStale', expectedMsgContains: 'needs to be refreshed' },
  { code: 6015, expectedName: 'LiquidationTooSmall', expectedMsgContains: 'too small' },
  { code: 6008, expectedName: 'InsufficientLiquidity', expectedMsgContains: 'Insufficient liquidity' },
  
  // Account/validation errors
  { code: 6000, expectedName: 'InvalidMarketAuthority', expectedMsgContains: 'Market authority' },
  { code: 6002, expectedName: 'InvalidAccountOwner', expectedMsgContains: 'owner' },
  { code: 6003, expectedName: 'InvalidAmount', expectedMsgContains: 'amount is invalid' },
  { code: 6024, expectedName: 'InvalidObligationCollateral', expectedMsgContains: 'collateral' },
  { code: 6025, expectedName: 'InvalidObligationLiquidity', expectedMsgContains: 'liquidity' },
  
  // Unknown error code
  { code: 9999, expectedName: 'Unknown', expectedMsgContains: 'Unknown' },
];

function runTests(): boolean {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║  Kamino KLend Error Decoder Tests            ║');
  console.log('╚═══════════════════════════════════════════════╝\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const tc of testCases) {
    const fullMessage = decodeKlendError(tc.code);
    const name = getKlendErrorName(tc.code);
    const msg = getKlendErrorMsg(tc.code);
    const isKnown = isKnownKlendError(tc.code);
    
    // Check if name matches
    const nameMatches = name?.includes(tc.expectedName) || fullMessage.includes(tc.expectedName);
    
    // Check if message contains expected substring
    const msgMatches = fullMessage.toLowerCase().includes(tc.expectedMsgContains.toLowerCase());
    
    // Check isKnown consistency
    const knownMatches = tc.code === 9999 ? !isKnown : isKnown;
    
    const testPassed = nameMatches && msgMatches && knownMatches;
    
    if (testPassed) {
      console.log(`✓ Code ${tc.code}: ${fullMessage}`);
      passed++;
    } else {
      console.error(`✗ Code ${tc.code} FAILED:`);
      console.error(`  Expected: ${tc.expectedName} - contains "${tc.expectedMsgContains}"`);
      console.error(`  Got: ${fullMessage}`);
      console.error(`  Name: ${name}, Msg: ${msg}, IsKnown: ${isKnown}`);
      failed++;
    }
  }
  
  console.log('\n' + '═'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    console.error('\n❌ Tests FAILED');
    return false;
  } else {
    console.log('\n✅ All tests PASSED');
    return true;
  }
}

// Run tests
const success = runTests();

// Exit with appropriate code
process.exit(success ? 0 : 1);
