/**
 * Test Script: Candidate Payload Normalization
 * 
 * Tests the normalizeCandidates() function with various payload structures.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Normalize any candidates payload into an array.
 * Supports: array, {data: [...]}, {candidates: [...]}, keyed object.
 */
function normalizeCandidates(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.candidates)) return payload.candidates;
  return Object.values(payload);
}

async function main() {
  console.log('🧪 Testing Candidate Payload Normalization\n');
  console.log('='.repeat(70));

  // Test 1: Array payload
  console.log('\n📝 Test 1: Array payload');
  const arrayPayload = [
    { key: 'test1', borrowValueUsd: 1000 },
    { key: 'test2', borrowValueUsd: 2000 },
  ];
  const normalized1 = normalizeCandidates(arrayPayload);
  console.log(`  Input: Array with ${arrayPayload.length} items`);
  console.log(`  Output: Array with ${normalized1.length} items`);
  console.log(`  ✅ ${normalized1.length === 2 ? 'PASS' : 'FAIL'}`);

  // Test 2: Object with "candidates" array
  console.log('\n📝 Test 2: Object with "candidates" array');
  const candidatesPayload = {
    candidates: [
      { key: 'test1', borrowValueUsd: 1000 },
      { key: 'test2', borrowValueUsd: 2000 },
    ]
  };
  const normalized2 = normalizeCandidates(candidatesPayload);
  console.log(`  Input: Object with candidates array (${candidatesPayload.candidates.length} items)`);
  console.log(`  Output: Array with ${normalized2.length} items`);
  console.log(`  ✅ ${normalized2.length === 2 ? 'PASS' : 'FAIL'}`);

  // Test 3: Object with "data" array
  console.log('\n📝 Test 3: Object with "data" array');
  const dataPayload = {
    data: [
      { key: 'test1', borrowValueUsd: 1000 },
      { key: 'test2', borrowValueUsd: 2000 },
    ]
  };
  const normalized3 = normalizeCandidates(dataPayload);
  console.log(`  Input: Object with data array (${dataPayload.data.length} items)`);
  console.log(`  Output: Array with ${normalized3.length} items`);
  console.log(`  ✅ ${normalized3.length === 2 ? 'PASS' : 'FAIL'}`);

  // Test 4: Keyed object (dictionary)
  console.log('\n📝 Test 4: Keyed object (dictionary)');
  const keyedPayload = {
    'pubkey1': { key: 'test1', borrowValueUsd: 1000 },
    'pubkey2': { key: 'test2', borrowValueUsd: 2000 },
  };
  const normalized4 = normalizeCandidates(keyedPayload);
  console.log(`  Input: Keyed object with ${Object.keys(keyedPayload).length} items`);
  console.log(`  Output: Array with ${normalized4.length} items`);
  console.log(`  ✅ ${normalized4.length === 2 ? 'PASS' : 'FAIL'}`);

  // Test 5: Empty object
  console.log('\n📝 Test 5: Empty object');
  const emptyPayload = {};
  const normalized5 = normalizeCandidates(emptyPayload);
  console.log(`  Input: Empty object`);
  console.log(`  Output: Array with ${normalized5.length} items`);
  console.log(`  ✅ ${normalized5.length === 0 ? 'PASS' : 'FAIL'}`);

  // Test 6: Null/undefined
  console.log('\n📝 Test 6: Null/undefined');
  const normalized6a = normalizeCandidates(null);
  const normalized6b = normalizeCandidates(undefined);
  console.log(`  Input: null`);
  console.log(`  Output: Array with ${normalized6a.length} items`);
  console.log(`  Input: undefined`);
  console.log(`  Output: Array with ${normalized6b.length} items`);
  console.log(`  ✅ ${normalized6a.length === 0 && normalized6b.length === 0 ? 'PASS' : 'FAIL'}`);

  // Test 7: Load actual candidates.json file
  console.log('\n📝 Test 7: Load actual candidates.json file');
  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
  if (fs.existsSync(candidatesPath)) {
    const rawPayload = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    const normalized7 = normalizeCandidates(rawPayload);
    console.log(`  File exists: Yes`);
    console.log(`  Raw payload type: ${Array.isArray(rawPayload) ? 'Array' : 'Object'}`);
    if (!Array.isArray(rawPayload) && typeof rawPayload === 'object') {
      console.log(`  Raw payload keys: ${Object.keys(rawPayload).join(', ')}`);
    }
    console.log(`  Normalized: Array with ${normalized7.length} items`);
    console.log(`  ✅ ${normalized7.length > 0 ? 'PASS' : 'FAIL'}`);
    
    // Show first candidate
    if (normalized7.length > 0) {
      console.log(`  First candidate key: ${normalized7[0].key ?? normalized7[0].obligationPubkey ?? 'unknown'}`);
    }
  } else {
    console.log(`  File exists: No`);
    console.log(`  ⚠️  SKIP`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('✅ All normalization tests completed!');
  console.log('='.repeat(70) + '\n');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
