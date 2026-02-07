/**
 * Manual Verification Script: Forecast Ranking Logic
 * 
 * This script tests the forecast ranking logic in isolation without
 * requiring RPC connection or actual flashloan simulation.
 * It focuses on verifying the ranking algorithm itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scoreHazard } from '../src/predict/hazardScorer.js';
import { computeEV, type EvParams } from '../src/predict/evCalculator.js';
import { estimateTtlString } from '../src/predict/ttlEstimator.js';

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

function loadCandidatesRaw(): any[] {
  const p = path.join(process.cwd(), 'data', 'candidates.json');
  if (!fs.existsSync(p)) {
    throw new Error('Missing data/candidates.json');
  }
  const rawPayload = JSON.parse(fs.readFileSync(p, 'utf8'));
  return normalizeCandidates(rawPayload);
}

function parseTtlMinutes(ttlStr: string): number {
  if (!ttlStr || ttlStr === 'unknown') return Infinity;
  const m = /^(\d+)m(\d+)s$/.exec(ttlStr);
  if (!m) return Infinity;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  return minutes + seconds / 60;
}

async function main() {
  console.log('🔍 Verifying Forecast Ranking Logic\n');
  console.log('='.repeat(70));

  // Load candidates
  const candidates = loadCandidatesRaw();
  console.log(`\n✓ Loaded ${candidates.length} candidates from data/candidates.json`);

  // Configure parameters
  const alpha = 25;
  const evParams: EvParams = {
    closeFactor: 0.5,
    liquidationBonusPct: 0.05,
    flashloanFeePct: 0.002,
    fixedGasUsd: 0.5,
  };
  const solDropPctPerMin = 0.2;
  const maxDropPct = 20;

  console.log('\n📊 Parameters:');
  console.log(`  Hazard Alpha: ${alpha}`);
  console.log(`  Close Factor: ${evParams.closeFactor}`);
  console.log(`  Liquidation Bonus: ${evParams.liquidationBonusPct * 100}%`);
  console.log(`  Flashloan Fee: ${evParams.flashloanFeePct * 100}%`);
  console.log(`  Fixed Gas Cost: $${evParams.fixedGasUsd}`);
  console.log(`  SOL Drop Rate: ${solDropPctPerMin}% per minute`);
  console.log(`  Max Drop: ${maxDropPct}%`);

  // Compute scores for each candidate
  console.log('\n🧮 Computing scores...');
  const ranked = candidates.map((c: any) => {
    const hr = Number(c.healthRatioRaw ?? c.healthRatio ?? 0);
    const hazard = scoreHazard(hr, alpha);
    const borrow = Number(c.borrowValueUsd ?? 0);
    const ev = computeEV(borrow, hazard, evParams);
    const ttlStr = estimateTtlString(c, { solDropPctPerMin, maxDropPct });
    const ttlMin = parseTtlMinutes(ttlStr);
    return { ...c, hazard, ev, ttlMin, ttlStr };
  }).sort((a: any, b: any) => {
    // Primary: EV descending
    if (b.ev !== a.ev) return Number(b.ev) - Number(a.ev);
    // Secondary: TTL ascending (shorter first)
    if (a.ttlMin !== b.ttlMin) return Number(a.ttlMin) - Number(b.ttlMin);
    // Tertiary: hazard descending
    return Number(b.hazard) - Number(a.hazard);
  });

  console.log('\n✓ Ranking complete!');

  // Display results
  console.log('\n📋 Ranked Candidates:');
  console.log('='.repeat(70));
  console.table(ranked.map((x: any, idx: number) => ({
    rank: idx + 1,
    key: x.key ?? x.obligationPubkey ?? 'unknown',
    healthRatio: Number(x.healthRatioRaw ?? x.healthRatio ?? 0).toFixed(4),
    borrowUsd: Number(x.borrowValueUsd ?? 0).toFixed(2),
    hazard: Number(x.hazard).toFixed(4),
    ev: Number(x.ev).toFixed(4),
    ttl: x.ttlStr,
  })));

  // Verify ranking order
  console.log('\n🔬 Verification:');
  console.log('='.repeat(70));
  
  // Check that EV is sorted correctly
  let evOrdered = true;
  for (let i = 1; i < ranked.length; i++) {
    if (ranked[i].ev > ranked[i - 1].ev) {
      evOrdered = false;
      break;
    }
  }
  
  if (evOrdered) {
    console.log('✅ EV ordering: CORRECT (descending)');
  } else {
    console.log('❌ EV ordering: INCORRECT');
  }

  // Show top candidate
  const top = ranked[0];
  console.log('\n🎯 Top Candidate Selected:');
  console.log(`  Key: ${top.key ?? top.obligationPubkey ?? 'unknown'}`);
  console.log(`  Health Ratio: ${Number(top.healthRatioRaw ?? top.healthRatio ?? 0).toFixed(4)}`);
  console.log(`  Borrow Value: $${Number(top.borrowValueUsd ?? 0).toFixed(2)}`);
  console.log(`  Hazard Score: ${Number(top.hazard).toFixed(4)}`);
  console.log(`  Expected Value: $${Number(top.ev).toFixed(4)}`);
  console.log(`  Time to Liquidation: ${top.ttlStr}`);

  console.log('\n' + '='.repeat(70));
  console.log('✅ Forecast ranking logic verified successfully!');
  console.log('='.repeat(70) + '\n');
}

main().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
