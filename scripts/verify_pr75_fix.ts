#!/usr/bin/env tsx
/**
 * PR75 Verification Script
 * Verifies that KaminoObligation.load fix is correct
 */

import fs from 'fs';
import path from 'path';

async function main() {
  console.log('🔍 PR75 Verification - KaminoObligation.load Fix\n');
  console.log('='.repeat(50));
  console.log('');

  let allPassed = true;

  // Test 1: Check that liquidationBuilder uses market parameter
  console.log('Test 1: Verify KaminoObligation.load uses market parameter');
  const liquidationBuilderPath = path.join(process.cwd(), 'src/kamino/liquidationBuilder.ts');
  const content = fs.readFileSync(liquidationBuilderPath, 'utf-8');
  
  // Check for correct pattern
  const correctPattern = /KaminoObligation\.load\s*\(\s*market\s*,/;
  const incorrectPattern = /KaminoObligation\.load\s*\(\s*rpc\s*,/;
  
  if (correctPattern.test(content)) {
    console.log('✅ KaminoObligation.load correctly uses market parameter');
  } else {
    console.log('❌ KaminoObligation.load does not use market parameter');
    allPassed = false;
  }
  
  if (incorrectPattern.test(content)) {
    console.log('❌ Found incorrect usage with rpc parameter');
    allPassed = false;
  } else {
    console.log('✅ No incorrect rpc parameter usage found');
  }
  console.log('');

  // Test 2: Verify imports use @solana/kit
  console.log('Test 2: Verify imports use @solana/kit');
  const kitImport = /import.*from\s+["']@solana\/kit["']/;
  const rpcImport = /import.*from\s+["']@solana\/rpc["']/;
  const addressImport = /import.*from\s+["']@solana\/addresses["']/;
  
  if (kitImport.test(content)) {
    console.log('✅ Uses @solana/kit import');
  } else {
    console.log('❌ Missing @solana/kit import');
    allPassed = false;
  }
  
  if (!rpcImport.test(content)) {
    console.log('✅ No @solana/rpc import found');
  } else {
    console.log('❌ Found forbidden @solana/rpc import');
    allPassed = false;
  }
  
  if (!addressImport.test(content)) {
    console.log('✅ No @solana/addresses import found');
  } else {
    console.log('❌ Found forbidden @solana/addresses import');
    allPassed = false;
  }
  console.log('');

  // Test 3: Check for address() helper usage
  console.log('Test 3: Verify address() helper is used');
  const addressHelperPattern = /address\(p\.obligationPubkey\.toBase58\(\)\)/;
  
  if (addressHelperPattern.test(content)) {
    console.log('✅ Uses address() helper for obligation address');
  } else {
    console.log('❌ Does not use address() helper correctly');
    allPassed = false;
  }
  console.log('');

  // Test 4: Check for risky casts in loader calls
  console.log('Test 4: Verify no risky "as any" casts in loader calls');
  const rpcAsAnyInLoad = /Kamino(?:Market|Obligation)\.load\s*\([^)]*rpc\s+as\s+any/;
  
  if (!rpcAsAnyInLoad.test(content)) {
    console.log('✅ No "rpc as any" casts in Kamino loader calls');
  } else {
    console.log('❌ Found risky "rpc as any" cast in loader call');
    allPassed = false;
  }
  console.log('');

  // Test 5: Verify correct order (market loaded before obligation)
  console.log('Test 5: Verify market is loaded before obligation');
  const marketLoadIndex = content.indexOf('KaminoMarket.load');
  const obligationLoadIndex = content.indexOf('KaminoObligation.load');
  
  if (marketLoadIndex !== -1 && obligationLoadIndex !== -1 && marketLoadIndex < obligationLoadIndex) {
    console.log('✅ Market is loaded before obligation (correct order)');
  } else {
    console.log('❌ Incorrect loading order');
    allPassed = false;
  }
  console.log('');

  // Test 6: Check that both use address() helper
  console.log('Test 6: Verify both loaders use address() helper');
  const lines = content.split('\n');
  let marketLoadSection = '';
  let obligationLoadSection = '';
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('KaminoMarket.load')) {
      marketLoadSection = lines.slice(i, i + 5).join('\n');
    }
    if (lines[i].includes('KaminoObligation.load')) {
      obligationLoadSection = lines.slice(i, i + 3).join('\n');
    }
  }
  
  const marketUsesAddress = /address\([^)]+\)/.test(marketLoadSection);
  const obligationUsesAddress = /address\([^)]+\)/.test(obligationLoadSection);
  
  if (marketUsesAddress) {
    console.log('✅ KaminoMarket.load uses address() helper');
  } else {
    console.log('❌ KaminoMarket.load missing address() helper');
    allPassed = false;
  }
  
  if (obligationUsesAddress) {
    console.log('✅ KaminoObligation.load uses address() helper');
  } else {
    console.log('❌ KaminoObligation.load missing address() helper');
    allPassed = false;
  }
  console.log('');

  // Summary
  console.log('='.repeat(50));
  if (allPassed) {
    console.log('✅ All PR75 verification tests passed!');
    console.log('   KaminoObligation.load fix is correct and complete');
    process.exit(0);
  } else {
    console.log('❌ Some verification tests failed');
    console.log('   Please review the issues above');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error during verification:', error);
  process.exit(1);
});
