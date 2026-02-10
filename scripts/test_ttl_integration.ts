/**
 * Integration test for TTL expiry logic
 * Verifies that the entire flow works end-to-end
 */

import { buildPlanFromCandidate, recomputePlanFields, type FlashloanPlan } from '../src/scheduler/txBuilder.js';
import { evaluateForecasts, type ForecastEntry, type TtlManagerParams } from '../src/predict/forecastTTLManager.js';

console.log('╔═══════════════════════════════════════════════╗');
console.log('║  TTL Expiry Logic Integration Test           ║');
console.log('╚═══════════════════════════════════════════════╝\n');

// Test 1: Build plan with positive TTL
console.log('Test 1: Build plan with positive TTL');
const candidate1 = {
  key: 'test-obligation-1',
  obligationPubkey: 'test-obligation-1',
  borrowValueUsd: 1000,
  healthRatio: 1.05,
  ev: 10,
  hazard: 0.5,
  ttlMin: 5,
  ttlStr: '5m00s',
  primaryBorrowMint: 'USDC',
  primaryCollateralMint: 'SOL',
};

const plan1 = buildPlanFromCandidate(candidate1);
console.log('  Plan created:');
console.log(`    key: ${plan1.key}`);
console.log(`    ttlMin: ${plan1.ttlMin}`);
console.log(`    predictedLiquidationAtMs: ${plan1.predictedLiquidationAtMs}`);
console.log(`    createdAtMs: ${plan1.createdAtMs}`);

if (plan1.ttlMin !== 5) {
  console.error('  ❌ FAIL: Expected ttlMin=5, got', plan1.ttlMin);
  process.exit(1);
}

if (plan1.predictedLiquidationAtMs === null || plan1.predictedLiquidationAtMs === undefined) {
  console.error('  ❌ FAIL: Expected predictedLiquidationAtMs to be set');
  process.exit(1);
}

// Check that predicted time is approximately 5 minutes in future
const expectedPredictedTime = plan1.createdAtMs + 5 * 60 * 1000;
const timeDiff = Math.abs(plan1.predictedLiquidationAtMs - expectedPredictedTime);
if (timeDiff > 1000) { // Allow 1s tolerance for execution time
  console.error(`  ❌ FAIL: Expected predictedLiquidationAtMs to be ~5 minutes in future, diff=${timeDiff}ms`);
  process.exit(1);
}

console.log('  ✅ PASS\n');

// Test 2: Build plan with unknown TTL
console.log('Test 2: Build plan with unknown TTL');
const candidate2 = {
  key: 'test-obligation-2',
  obligationPubkey: 'test-obligation-2',
  borrowValueUsd: 1000,
  healthRatio: 1.15,
  ev: 10,
  hazard: 0.3,
  ttlMin: null,
  ttlStr: 'unknown',
  primaryBorrowMint: 'USDC',
  primaryCollateralMint: 'SOL',
};

const plan2 = buildPlanFromCandidate(candidate2);
console.log('  Plan created:');
console.log(`    key: ${plan2.key}`);
console.log(`    ttlMin: ${plan2.ttlMin}`);
console.log(`    predictedLiquidationAtMs: ${plan2.predictedLiquidationAtMs}`);

if (plan2.ttlMin !== null) {
  console.error('  ❌ FAIL: Expected ttlMin=null for unknown TTL, got', plan2.ttlMin);
  process.exit(1);
}

if (plan2.predictedLiquidationAtMs !== null) {
  console.error('  ❌ FAIL: Expected predictedLiquidationAtMs=null for unknown TTL');
  process.exit(1);
}

console.log('  ✅ PASS\n');

// Test 3: Evaluate forecasts with TTL grace logic
console.log('Test 3: Evaluate forecasts with TTL grace logic');
const nowMs = Date.now();

const forecasts: ForecastEntry[] = [
  {
    key: 'test1',
    ev: 10,
    hazard: 0.5,
    ttlMin: 0,
    ttlStr: 'now',
    predictedLiquidationAtMs: nowMs + 30_000, // 30s in future (within 60s grace)
    forecastUpdatedAtMs: nowMs,
  },
  {
    key: 'test2',
    ev: 10,
    hazard: 0.5,
    ttlMin: 0,
    ttlStr: 'now',
    predictedLiquidationAtMs: nowMs - 120_000, // 2 minutes ago (past grace)
    forecastUpdatedAtMs: nowMs - 120_000,
  },
  {
    key: 'test3',
    ev: 10,
    hazard: 0.5,
    ttlMin: null,
    ttlStr: 'unknown',
    predictedLiquidationAtMs: null,
    forecastUpdatedAtMs: nowMs,
  },
];

const params: TtlManagerParams = {
  forecastMaxAgeMs: 300_000,
  ttlGraceMs: 60_000,
  ttlUnknownPasses: true,
  evDropPct: 0.15,
  minEv: 0,
};

const results = evaluateForecasts(forecasts, params, { nowMs });

console.log('  Forecast 1 (TTL=0, within grace):');
console.log(`    expired: ${results[0].expired} (expected: false)`);
if (results[0].expired !== false) {
  console.error('  ❌ FAIL: Expected not expired');
  process.exit(1);
}
console.log('    ✅ PASS');

console.log('  Forecast 2 (TTL=0, past grace):');
console.log(`    expired: ${results[1].expired} (expected: true)`);
console.log(`    reason: ${results[1].reason} (expected to contain: ttl_grace_exceeded)`);
if (results[1].expired !== true || !results[1].reason?.includes('ttl_grace_exceeded')) {
  console.error('  ❌ FAIL: Expected expired with ttl_grace_exceeded reason');
  process.exit(1);
}
console.log('    ✅ PASS');

console.log('  Forecast 3 (unknown TTL, passes enabled):');
console.log(`    expired: ${results[2].expired} (expected: false)`);
if (results[2].expired !== false) {
  console.error('  ❌ FAIL: Expected not expired');
  process.exit(1);
}
console.log('    ✅ PASS\n');

// Test 4: Recompute plan fields
console.log('Test 4: Recompute plan fields');
const updatedCandidate = {
  ...candidate1,
  healthRatio: 1.03,
  borrowValueUsd: 1100,
};

const recomputedPlan = recomputePlanFields(plan1, updatedCandidate);
console.log('  Recomputed plan:');
console.log(`    ttlMin: ${recomputedPlan.ttlMin}`);
console.log(`    prevEv: ${recomputedPlan.prevEv} (expected: ${plan1.ev})`);
console.log(`    predictedLiquidationAtMs updated: ${recomputedPlan.predictedLiquidationAtMs !== plan1.predictedLiquidationAtMs}`);
console.log(`    amountUsd: ${recomputedPlan.amountUsd} (expected: 1100)`);

if (recomputedPlan.ttlMin === null || recomputedPlan.ttlMin === undefined) {
  console.error('  ❌ FAIL: Expected ttlMin to be computed');
  process.exit(1);
}

if (recomputedPlan.prevEv !== plan1.ev) {
  console.error('  ❌ FAIL: Expected prevEv to be preserved');
  process.exit(1);
}

if (recomputedPlan.predictedLiquidationAtMs === plan1.predictedLiquidationAtMs) {
  console.error('  ❌ FAIL: Expected predictedLiquidationAtMs to be updated');
  process.exit(1);
}

if (Math.abs(recomputedPlan.amountUsd - 1100) > 0.01) {
  console.error('  ❌ FAIL: Expected amountUsd to be updated to 1100');
  process.exit(1);
}

console.log('  ✅ PASS\n');

console.log('═══════════════════════════════════════════════');
console.log('All integration tests passed!');
console.log('═══════════════════════════════════════════════\n');
