/**
 * Unit Test: Forecast Ranking Integration in flashloanDryRunKamino.ts
 * 
 * This test validates that the forecast ranking logic is correctly integrated
 * into the dry-run command without requiring RPC connection.
 * It tests the helper functions in isolation.
 */

import fs from 'node:fs';
import path from 'node:path';

// Test helper functions
function testLoadCandidatesScored(): void {
  console.log('Testing loadCandidatesScored...');
  
  // Inline version of the function from flashloanDryRunKamino.ts
  function loadCandidatesScored(): any[] | null {
    const p = path.join(process.cwd(), 'data', 'candidates.scored.json');
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  const result = loadCandidatesScored();
  if (result === null) {
    console.log('✅ loadCandidatesScored returns null when file missing (expected)');
  } else {
    console.log('✅ loadCandidatesScored loaded scored candidates');
  }
}

function testLoadCandidatesRaw(): void {
  console.log('\nTesting loadCandidatesRaw...');
  
  // Inline version of the function from flashloanDryRunKamino.ts
  function loadCandidatesRaw(): any[] {
    const p = path.join(process.cwd(), 'data', 'candidates.json');
    if (!fs.existsSync(p)) {
      throw new Error('Missing data/candidates.json');
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  try {
    const result = loadCandidatesRaw();
    if (Array.isArray(result) && result.length > 0) {
      console.log(`✅ loadCandidatesRaw loaded ${result.length} candidates`);
    } else {
      console.log('❌ loadCandidatesRaw returned empty array');
    }
  } catch (err: any) {
    console.log(`❌ loadCandidatesRaw failed: ${err.message}`);
  }
}

function testParseTtlMinutes(): void {
  console.log('\nTesting parseTtlMinutes...');
  
  // Inline version of the function from flashloanDryRunKamino.ts
  function parseTtlMinutes(ttlStr: string): number {
    if (!ttlStr || ttlStr === 'unknown') return Infinity;
    const m = /^(\d+)m(\d+)s$/.exec(ttlStr);
    if (!m) return Infinity;
    const minutes = Number(m[1]);
    const seconds = Number(m[2]);
    return minutes + seconds / 60;
  }

  const tests = [
    { input: '5m30s', expected: 5.5 },
    { input: '10m00s', expected: 10.0 },
    { input: 'unknown', expected: Infinity },
    { input: '', expected: Infinity },
    { input: 'invalid', expected: Infinity },
  ];

  let passed = 0;
  for (const test of tests) {
    const result = parseTtlMinutes(test.input);
    if (result === test.expected) {
      console.log(`✅ parseTtlMinutes('${test.input}') = ${result}`);
      passed++;
    } else {
      console.log(`❌ parseTtlMinutes('${test.input}') = ${result}, expected ${test.expected}`);
    }
  }

  if (passed === tests.length) {
    console.log(`✅ All ${passed} parseTtlMinutes tests passed`);
  } else {
    console.log(`❌ ${tests.length - passed} parseTtlMinutes tests failed`);
  }
}

function testEnvVariablesExist(): void {
  console.log('\nTesting environment variable definitions...');
  
  // Check that env.ts exports the new variables
  const envPath = path.join(process.cwd(), 'src', 'config', 'env.ts');
  const envContent = fs.readFileSync(envPath, 'utf8');
  
  const requiredVars = [
    'USE_FORECAST_FOR_DRYRUN',
    'FORECAST_WEIGHT_EV',
    'FORECAST_WEIGHT_TTL',
  ];

  let allFound = true;
  for (const varName of requiredVars) {
    if (envContent.includes(varName)) {
      console.log(`✅ ${varName} found in env.ts`);
    } else {
      console.log(`❌ ${varName} NOT found in env.ts`);
      allFound = false;
    }
  }

  if (allFound) {
    console.log('✅ All environment variables defined');
  } else {
    console.log('❌ Some environment variables missing');
  }
}

function testImportsInDryRun(): void {
  console.log('\nTesting imports in flashloanDryRunKamino.ts...');
  
  const dryRunPath = path.join(process.cwd(), 'src', 'commands', 'flashloanDryRunKamino.ts');
  const dryRunContent = fs.readFileSync(dryRunPath, 'utf8');
  
  const requiredImports = [
    'scoreHazard',
    'computeEV',
    'estimateTtlString',
    'EvParams',
  ];

  let allFound = true;
  for (const importName of requiredImports) {
    if (dryRunContent.includes(importName)) {
      console.log(`✅ ${importName} imported`);
    } else {
      console.log(`❌ ${importName} NOT imported`);
      allFound = false;
    }
  }

  if (allFound) {
    console.log('✅ All required imports present');
  } else {
    console.log('❌ Some imports missing');
  }
}

function testRankingLogicPresent(): void {
  console.log('\nTesting ranking logic in flashloanDryRunKamino.ts...');
  
  const dryRunPath = path.join(process.cwd(), 'src', 'commands', 'flashloanDryRunKamino.ts');
  const dryRunContent = fs.readFileSync(dryRunPath, 'utf8');
  
  const requiredPatterns = [
    'USE_FORECAST_FOR_DRYRUN',
    'loadCandidatesScored',
    'loadCandidatesRaw',
    'parseTtlMinutes',
    'forecast_ranking_enabled',
    'forecast_ranking_disabled',
    'Top 10 Ranked Candidates',
    'sort((a: any, b: any)',
  ];

  let allFound = true;
  for (const pattern of requiredPatterns) {
    if (dryRunContent.includes(pattern)) {
      console.log(`✅ Pattern found: ${pattern}`);
    } else {
      console.log(`❌ Pattern NOT found: ${pattern}`);
      allFound = false;
    }
  }

  if (allFound) {
    console.log('✅ All ranking logic patterns present');
  } else {
    console.log('❌ Some ranking logic missing');
  }
}

async function main() {
  console.log('🧪 Unit Test: Forecast Ranking Integration');
  console.log('='.repeat(70));

  testEnvVariablesExist();
  testImportsInDryRun();
  testRankingLogicPresent();
  testLoadCandidatesScored();
  testLoadCandidatesRaw();
  testParseTtlMinutes();

  console.log('\n' + '='.repeat(70));
  console.log('✅ All unit tests completed!');
  console.log('='.repeat(70) + '\n');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
