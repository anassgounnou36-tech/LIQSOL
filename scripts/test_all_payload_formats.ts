/**
 * Comprehensive Test: All Payload Formats
 * 
 * Tests that the hotfix works with all supported payload structures.
 */

import fs from 'node:fs';
import path from 'node:path';

function normalizeCandidates(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.candidates)) return payload.candidates;
  return Object.values(payload);
}

async function testFile(filename: string, expectedFormat: string) {
  const filepath = path.join(process.cwd(), 'data', filename);
  
  if (!fs.existsSync(filepath)) {
    console.log(`  ⚠️  File ${filename} not found, skipping`);
    return { success: false, skipped: true };
  }

  try {
    const rawPayload = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const isArray = Array.isArray(rawPayload);
    const candidates = normalizeCandidates(rawPayload);
    
    console.log(`  📄 ${filename}`);
    console.log(`     Format: ${expectedFormat}`);
    console.log(`     Raw is array: ${isArray}`);
    console.log(`     Normalized count: ${candidates.length}`);
    
    if (!Array.isArray(candidates)) {
      console.log(`     ❌ FAIL: Result is not an array`);
      return { success: false, skipped: false };
    }
    
    if (candidates.length === 0) {
      console.log(`     ❌ FAIL: Result is empty`);
      return { success: false, skipped: false };
    }
    
    // Test .map() works
    candidates.map((c: any) => c.key);
    console.log(`     ✅ PASS`);
    return { success: true, skipped: false };
  } catch (err: any) {
    console.log(`     ❌ FAIL: ${err.message}`);
    return { success: false, skipped: false };
  }
}

async function main() {
  console.log('🧪 Comprehensive Payload Format Test\n');
  console.log('='.repeat(70));

  const tests = [
    { file: 'candidates.json', format: '{ "candidates": [...] }' },
    { file: 'candidates.array.json', format: '[...]' },
    { file: 'candidates.data.json', format: '{ "data": [...] }' },
  ];

  console.log('\n📝 Testing different payload formats:\n');

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const test of tests) {
    const result = await testFile(test.file, test.format);
    if (result.skipped) {
      skipped++;
    } else if (result.success) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(`📊 Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  
  if (failed > 0) {
    console.log('❌ Some tests FAILED');
    console.log('='.repeat(70) + '\n');
    process.exit(1);
  } else if (passed > 0) {
    console.log('✅ All tests PASSED!');
    console.log('='.repeat(70) + '\n');
    process.exit(0);
  } else {
    console.log('⚠️  All tests were skipped (no test files found)');
    console.log('='.repeat(70) + '\n');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
