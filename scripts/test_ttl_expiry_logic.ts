/**
 * Unit test for TTL expiry logic
 * Tests TTL classification rules with various scenarios
 */

import { evaluateForecasts, type ForecastEntry, type TtlManagerParams } from '../src/predict/forecastTTLManager.js';

interface TestCase {
  name: string;
  forecast: ForecastEntry;
  params: TtlManagerParams;
  expectedExpired: boolean;
  expectedReason?: string;
}

const nowMs = Date.now();
const ttlGraceMs = 60_000; // 60 seconds

const testCases: TestCase[] = [
  {
    name: 'Positive TTL within grace period',
    forecast: {
      key: 'test1',
      ev: 10,
      hazard: 0.5,
      ttlStr: '5m00s',
      ttlMin: 5,
      predictedLiquidationAtMs: nowMs + 5 * 60 * 1000, // 5 minutes in future
      forecastUpdatedAtMs: nowMs,
    },
    params: {
      forecastMaxAgeMs: 300_000,
      ttlGraceMs,
      evDropPct: 0.15,
      minEv: 0,
      ttlUnknownPasses: true,
    },
    expectedExpired: false,
  },
  {
    name: 'TTL=0 with future predictedLiquidationAt (within grace)',
    forecast: {
      key: 'test2',
      ev: 10,
      hazard: 0.5,
      ttlStr: 'now',
      ttlMin: 0,
      predictedLiquidationAtMs: nowMs + 30_000, // 30s in future (within 60s grace)
      forecastUpdatedAtMs: nowMs,
    },
    params: {
      forecastMaxAgeMs: 300_000,
      ttlGraceMs,
      evDropPct: 0.15,
      minEv: 0,
      ttlUnknownPasses: true,
    },
    expectedExpired: false,
  },
  {
    name: 'TTL=0 past predictedLiquidationAt + grace',
    forecast: {
      key: 'test3',
      ev: 10,
      hazard: 0.5,
      ttlStr: 'now',
      ttlMin: 0,
      predictedLiquidationAtMs: nowMs - 120_000, // 2 minutes ago
      forecastUpdatedAtMs: nowMs - 120_000,
    },
    params: {
      forecastMaxAgeMs: 300_000,
      ttlGraceMs,
      evDropPct: 0.15,
      minEv: 0,
      ttlUnknownPasses: true,
    },
    expectedExpired: true,
    expectedReason: 'ttl_grace_exceeded',
  },
  {
    name: 'Unknown TTL with TTL_UNKNOWN_PASSES=true',
    forecast: {
      key: 'test4',
      ev: 10,
      hazard: 0.5,
      ttlStr: 'unknown',
      ttlMin: null,
      predictedLiquidationAtMs: null,
      forecastUpdatedAtMs: nowMs,
    },
    params: {
      forecastMaxAgeMs: 300_000,
      ttlGraceMs,
      evDropPct: 0.15,
      minEv: 0,
      ttlUnknownPasses: true,
    },
    expectedExpired: false,
  },
  {
    name: 'Unknown TTL with TTL_UNKNOWN_PASSES=false',
    forecast: {
      key: 'test5',
      ev: 10,
      hazard: 0.5,
      ttlStr: 'unknown',
      ttlMin: null,
      predictedLiquidationAtMs: null,
      forecastUpdatedAtMs: nowMs,
    },
    params: {
      forecastMaxAgeMs: 300_000,
      ttlGraceMs,
      evDropPct: 0.15,
      minEv: 0,
      ttlUnknownPasses: false,
    },
    expectedExpired: true,
    expectedReason: 'ttl_unknown',
  },
  {
    name: 'Negative TTL',
    forecast: {
      key: 'test6',
      ev: 10,
      hazard: 0.5,
      ttlStr: 'now',
      ttlMin: -1,
      predictedLiquidationAtMs: nowMs - 60_000, // 1 minute ago
      forecastUpdatedAtMs: nowMs,
    },
    params: {
      forecastMaxAgeMs: 300_000,
      ttlGraceMs,
      evDropPct: 0.15,
      minEv: 0,
      ttlUnknownPasses: true,
    },
    expectedExpired: true,
    expectedReason: 'ttl_negative',
  },
  {
    name: 'Small positive TTL (0.05 min = 3s) within grace',
    forecast: {
      key: 'test7',
      ev: 10,
      hazard: 0.5,
      ttlStr: '0m03s',
      ttlMin: 0.05,
      predictedLiquidationAtMs: nowMs + 3_000, // 3s in future
      forecastUpdatedAtMs: nowMs,
    },
    params: {
      forecastMaxAgeMs: 300_000,
      ttlGraceMs,
      evDropPct: 0.15,
      minEv: 0,
      ttlUnknownPasses: true,
    },
    expectedExpired: false,
  },
  {
    name: 'Forecast age exceeds max age',
    forecast: {
      key: 'test8',
      ev: 10,
      hazard: 0.5,
      ttlStr: '10m00s',
      ttlMin: 10,
      predictedLiquidationAtMs: nowMs + 10 * 60 * 1000,
      forecastUpdatedAtMs: nowMs - 400_000, // 400s ago (> 300s max)
    },
    params: {
      forecastMaxAgeMs: 300_000,
      ttlGraceMs,
      evDropPct: 0.15,
      minEv: 0,
      ttlUnknownPasses: true,
    },
    expectedExpired: true,
    expectedReason: 'age',
  },
];

function runTests() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║  TTL Expiry Logic Unit Tests                 ║');
  console.log('╚═══════════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;

  for (const test of testCases) {
    const results = evaluateForecasts([test.forecast], test.params, { nowMs });
    const result = results[0];

    const expiredMatch = result.expired === test.expectedExpired;
    const reasonMatch = !test.expectedReason || (result.reason && result.reason.includes(test.expectedReason));

    if (expiredMatch && reasonMatch) {
      console.log(`✅ PASS: ${test.name}`);
      console.log(`   Expected expired=${test.expectedExpired}, got expired=${result.expired}`);
      if (test.expectedReason) {
        console.log(`   Expected reason contains "${test.expectedReason}", got "${result.reason}"`);
      }
      passed++;
    } else {
      console.log(`❌ FAIL: ${test.name}`);
      console.log(`   Expected expired=${test.expectedExpired}, got expired=${result.expired}`);
      if (test.expectedReason) {
        console.log(`   Expected reason contains "${test.expectedReason}", got "${result.reason}"`);
      }
      console.log(`   Forecast:`, {
        ttlMin: test.forecast.ttlMin,
        predictedLiquidationAtMs: test.forecast.predictedLiquidationAtMs,
        forecastUpdatedAtMs: test.forecast.forecastUpdatedAtMs,
      });
      failed++;
    }
    console.log('');
  }

  console.log('═══════════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
