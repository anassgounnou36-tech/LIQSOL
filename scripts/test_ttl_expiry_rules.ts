/**
 * Unit tests for TTL expiry rules
 * Tests the expiry classification logic to ensure:
 * - Plans with small positive ttlMinRaw and future predictedAt are NOT expired
 * - Plans with ttlMinRaw=0 and predictedAt=now are NOT expired until grace passes
 * - Plans with predictedAt past grace period ARE expired
 * - Plans with null predictedAt follow TTL_UNKNOWN_PASSES policy
 */

import { evaluateForecasts, type ForecastEntry, type TtlManagerParams } from '../src/predict/forecastTTLManager.js';

interface TestCase {
  name: string;
  forecast: ForecastEntry;
  params: TtlManagerParams;
  nowMs: number;
  expectedExpired: boolean;
  expectedReason?: string;
}

function runTest(tc: TestCase): boolean {
  const result = evaluateForecasts([tc.forecast], tc.params, { nowMs: tc.nowMs });
  const actual = result[0];
  
  const passed = actual.expired === tc.expectedExpired;
  const reasonMatch = !tc.expectedReason || (actual.reason?.includes(tc.expectedReason) ?? false);
  
  if (passed && reasonMatch) {
    console.log(`✅ PASS: ${tc.name}`);
    return true;
  } else {
    console.log(`❌ FAIL: ${tc.name}`);
    console.log(`  Expected expired: ${tc.expectedExpired}, got: ${actual.expired}`);
    if (tc.expectedReason) {
      console.log(`  Expected reason to include: "${tc.expectedReason}", got: "${actual.reason}"`);
    }
    return false;
  }
}

function main() {
  console.log('🧪 Testing TTL Expiry Rules\n');
  console.log('='.repeat(70));
  
  const baseParams: TtlManagerParams = {
    forecastMaxAgeMs: 300_000, // 5 min
    ttlGraceMs: 60_000, // 60 seconds
    ttlUnknownPasses: true,
    evDropPct: 0.15,
    minEv: 0,
  };
  
  const nowMs = Date.now();
  
  const tests: TestCase[] = [
    // Test 1: Small positive ttlMinRaw with future predictedAt -> NOT expired
    {
      name: 'ttlMinRaw=0.01 with predictedAt in future',
      forecast: {
        key: 'test1',
        ev: 10,
        hazard: 0.5,
        ttlMin: 0.01, // 0.6 seconds
        ttlStr: '0m01s',
        predictedLiquidationAtMs: nowMs + 60_000, // 60 seconds in future
        forecastUpdatedAtMs: nowMs - 10_000, // 10 seconds old
      },
      params: baseParams,
      nowMs,
      expectedExpired: false,
    },
    
    // Test 2: ttlMinRaw=0 with predictedAt=now -> NOT expired (within grace)
    {
      name: 'ttlMinRaw=0 with predictedAt=now',
      forecast: {
        key: 'test2',
        ev: 10,
        hazard: 0.5,
        ttlMin: 0,
        ttlStr: 'now',
        predictedLiquidationAtMs: nowMs, // exactly now
        forecastUpdatedAtMs: nowMs - 10_000,
      },
      params: baseParams,
      nowMs,
      expectedExpired: false,
    },
    
    // Test 3: predictedAt past by more than grace -> expired
    {
      name: 'predictedAt past by more than grace',
      forecast: {
        key: 'test3',
        ev: 10,
        hazard: 0.5,
        ttlMin: 0,
        ttlStr: 'now',
        predictedLiquidationAtMs: nowMs - 120_000, // 2 minutes ago
        forecastUpdatedAtMs: nowMs - 150_000,
      },
      params: baseParams,
      nowMs,
      expectedExpired: true,
      expectedReason: 'ttl_grace_exceeded',
    },
    
    // Test 4: predictedAt null with TTL_UNKNOWN_PASSES=true -> NOT expired
    {
      name: 'predictedAt null with TTL_UNKNOWN_PASSES=true',
      forecast: {
        key: 'test4',
        ev: 10,
        hazard: 0.5,
        ttlMin: null,
        ttlStr: 'unknown',
        predictedLiquidationAtMs: null,
        forecastUpdatedAtMs: nowMs - 10_000,
      },
      params: { ...baseParams, ttlUnknownPasses: true },
      nowMs,
      expectedExpired: false,
    },
    
    // Test 5: predictedAt null with TTL_UNKNOWN_PASSES=false -> expired
    {
      name: 'predictedAt null with TTL_UNKNOWN_PASSES=false',
      forecast: {
        key: 'test5',
        ev: 10,
        hazard: 0.5,
        ttlMin: null,
        ttlStr: 'unknown',
        predictedLiquidationAtMs: null,
        forecastUpdatedAtMs: nowMs - 10_000,
      },
      params: { ...baseParams, ttlUnknownPasses: false },
      nowMs,
      expectedExpired: true,
      expectedReason: 'ttl_unknown',
    },
    
    // Test 6: Negative ttlMin -> expired
    {
      name: 'ttlMin negative',
      forecast: {
        key: 'test6',
        ev: 10,
        hazard: 0.5,
        ttlMin: -5,
        ttlStr: 'now',
        predictedLiquidationAtMs: nowMs - 300_000, // 5 minutes ago
        forecastUpdatedAtMs: nowMs - 10_000,
      },
      params: baseParams,
      nowMs,
      expectedExpired: true,
      expectedReason: 'ttl_negative',
    },
    
    // Test 7: predictedAt exactly at grace boundary -> NOT expired
    {
      name: 'predictedAt exactly at grace boundary',
      forecast: {
        key: 'test7',
        ev: 10,
        hazard: 0.5,
        ttlMin: 1,
        ttlStr: '1m00s',
        predictedLiquidationAtMs: nowMs - 60_000, // exactly grace period ago
        forecastUpdatedAtMs: nowMs - 70_000,
      },
      params: baseParams,
      nowMs,
      expectedExpired: false, // not expired because now <= predictedAt + grace (equality)
    },
    
    // Test 8: predictedAt one millisecond past grace -> expired
    {
      name: 'predictedAt one millisecond past grace',
      forecast: {
        key: 'test8',
        ev: 10,
        hazard: 0.5,
        ttlMin: 1,
        ttlStr: '1m00s',
        predictedLiquidationAtMs: nowMs - 60_001, // 1ms past grace period
        forecastUpdatedAtMs: nowMs - 70_000,
      },
      params: baseParams,
      nowMs,
      expectedExpired: true,
      expectedReason: 'ttl_grace_exceeded',
    },
    
    // Test 9: Very small ttlMinRaw (0.001 min = 60ms) with near-future predictedAt
    {
      name: 'Very small ttlMinRaw (0.001 min) with near-future predictedAt',
      forecast: {
        key: 'test9',
        ev: 10,
        hazard: 0.5,
        ttlMin: 0.001, // 60ms
        ttlStr: '0m00s',
        predictedLiquidationAtMs: nowMs + 60, // 60ms in future
        forecastUpdatedAtMs: nowMs - 10_000,
      },
      params: baseParams,
      nowMs,
      expectedExpired: false,
    },
    
    // Test 10: Forecast age exceeds max age -> expired (age-based expiry)
    {
      name: 'Forecast age exceeds max age',
      forecast: {
        key: 'test10',
        ev: 10,
        hazard: 0.5,
        ttlMin: 10,
        ttlStr: '10m00s',
        predictedLiquidationAtMs: nowMs + 600_000, // 10 minutes in future
        forecastUpdatedAtMs: nowMs - 400_000, // 400 seconds = ~6.67 minutes old (exceeds 5 min max)
      },
      params: baseParams,
      nowMs,
      expectedExpired: true,
      expectedReason: 'age',
    },
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    if (runTest(test)) {
      passed++;
    } else {
      failed++;
    }
  }
  
  console.log('\n' + '='.repeat(70));
  console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed\n`);
  
  if (failed === 0) {
    console.log('✅ All tests passed!');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed');
    process.exit(1);
  }
}

main();
