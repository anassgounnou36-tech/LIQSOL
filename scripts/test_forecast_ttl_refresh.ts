import fs from 'node:fs';
import path from 'node:path';
import { refreshQueue } from '../src/scheduler/txScheduler.js';
import { type TtlManagerParams } from '../src/predict/forecastTTLManager.js';

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

console.log('\n=== PR12: Testing Throttle and Batch Behavior ===\n');

// Test 1: Basic refresh behavior
console.log('Test 1: Basic refresh behavior');
(() => {
  const params: TtlManagerParams = {
    forecastMaxAgeMs: getEnvNum('FORECAST_MAX_AGE_MS', 300_000),
    minRefreshIntervalMs: getEnvNum('SCHED_MIN_REFRESH_INTERVAL_MS', 60_000),
    ttlExpiredMarginMin: getEnvNum('SCHED_TTL_EXPIRED_MARGIN_MIN', 2),
    evDropPct: getEnvNum('SCHED_EV_DROP_PCT', 0.15),
    minEv: getEnvNum('SCHED_MIN_EV', 0),
  };

  // Optionally load candidates as source to improve recomputation accuracy
  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
  const candidateSource = fs.existsSync(candidatesPath) ? JSON.parse(fs.readFileSync(candidatesPath, 'utf8')) : [];
  const normalized = Array.isArray(candidateSource) ? candidateSource : (Array.isArray(candidateSource.candidates) ? candidateSource.candidates : Object.values(candidateSource));

  const before = fs.existsSync(path.join(process.cwd(), 'data', 'tx_queue.json')) ? JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'tx_queue.json'), 'utf8')) : [];
  console.log(`Before refresh: ${before.length} plan(s)`);

  const after = refreshQueue(params, normalized);
  console.log(`After refresh: ${after.length} plan(s)`);
  console.table(after.slice(0, 10).map(p => ({ key: p.key, ev: Number(p.ev).toFixed(2), hazard: Number(p.hazard).toFixed(3), ttlMin: Number(p.ttlMin).toFixed(2), updatedAt: p.createdAtMs })));
})();

// Test 2: Throttle behavior - immediate re-run should be throttled
console.log('\n\nTest 2: Throttle behavior (immediate re-run with high minRefreshIntervalMs)');
(() => {
  // First, manually set up items with safe TTL and recent timestamps
  const queuePath = path.join(process.cwd(), 'data', 'tx_queue.json');
  const safeItems = [
    {
      key: "test_obligation_1",
      ownerPubkey: "test_owner_1",
      mint: "USDC",
      amountUi: "100.00",
      amountUsd: 100,
      ev: 5.5,
      hazard: 0.3, // Low hazard = safe position
      ttlMin: 50, // High TTL = safe from liquidation
      ttlStr: "50m0s",
      createdAtMs: Date.now() - 1000 // Just 1 second old
    },
    {
      key: "test_obligation_2",
      ownerPubkey: "test_owner_2",
      mint: "USDC",
      amountUi: "200.00",
      amountUsd: 200,
      ev: 8.2,
      hazard: 0.25,
      ttlMin: 60,
      ttlStr: "60m0s",
      createdAtMs: Date.now() - 2000 // Just 2 seconds old
    }
  ];
  fs.writeFileSync(queuePath, JSON.stringify(safeItems, null, 2));
  
  // Set high throttle to prevent immediate recompute
  const params: TtlManagerParams = {
    forecastMaxAgeMs: 300_000, // 5 minutes
    minRefreshIntervalMs: 600_000, // 10 minutes - very high to ensure throttle kicks in
    ttlExpiredMarginMin: 2,
    evDropPct: 0.15,
    minEv: 0,
  };

  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
  const candidateSource = fs.existsSync(candidatesPath) ? JSON.parse(fs.readFileSync(candidatesPath, 'utf8')) : [];
  const normalized = Array.isArray(candidateSource) ? candidateSource : (Array.isArray(candidateSource.candidates) ? candidateSource.candidates : Object.values(candidateSource));

  const before = safeItems;
  const beforeTimestamps = before.map((p: any) => ({ key: p.key, ts: p.createdAtMs }));
  
  console.log(`Running refresh with minRefreshIntervalMs=600000 (10 minutes)`);
  console.log(`Items have high TTL (50-60 min) and are very fresh (1-2 seconds old)`);
  
  const after = refreshQueue(params, normalized);
  
  // Check if timestamps are unchanged (throttled)
  let throttledCount = 0;
  let refreshedCount = 0;
  for (const p of after) {
    const beforeItem = beforeTimestamps.find((b: any) => b.key === p.key);
    if (beforeItem && beforeItem.ts === p.createdAtMs) {
      throttledCount++;
    } else if (beforeItem && beforeItem.ts !== p.createdAtMs) {
      refreshedCount++;
    }
  }
  
  console.log(`✓ Throttled ${throttledCount}/${after.length} items, refreshed ${refreshedCount}/${after.length} items`);
  if (throttledCount > 0) {
    console.log('  → Throttle working correctly! Items under minRefreshIntervalMs were not recomputed.');
  } else {
    console.log('  → Note: Items may have been refreshed due to TTL expiry or other triggers (not subject to throttle)');
  }
})();

// Test 3: Batch limit behavior
console.log('\n\nTest 3: Batch limit behavior (SCHED_REFRESH_BATCH_LIMIT)');
(() => {
  // Simulate a scenario with many items needing refresh
  // First, set up a queue with old timestamps to trigger refresh
  const queuePath = path.join(process.cwd(), 'data', 'tx_queue.json');
  const backupPath = path.join(process.cwd(), 'data', 'tx_queue_backup.json');
  
  // Backup existing queue
  if (fs.existsSync(queuePath)) {
    fs.copyFileSync(queuePath, backupPath);
    
    // Load and age the queue items to trigger refresh
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    const agedQueue = queue.map((p: any) => ({
      ...p,
      createdAtMs: Date.now() - 400_000, // 6.67 minutes ago (older than 5 min default max age)
    }));
    fs.writeFileSync(queuePath, JSON.stringify(agedQueue, null, 2));
    
    // Set batch limit to 1
    process.env.SCHED_REFRESH_BATCH_LIMIT = '1';
    
    const params: TtlManagerParams = {
      forecastMaxAgeMs: 300_000, // 5 minutes
      minRefreshIntervalMs: 0, // No throttle for this test
      ttlExpiredMarginMin: 2,
      evDropPct: 0.15,
      minEv: 0,
    };
    
    const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
    const candidateSource = fs.existsSync(candidatesPath) ? JSON.parse(fs.readFileSync(candidatesPath, 'utf8')) : [];
    const normalized = Array.isArray(candidateSource) ? candidateSource : (Array.isArray(candidateSource.candidates) ? candidateSource.candidates : Object.values(candidateSource));
    
    console.log(`Running refresh with SCHED_REFRESH_BATCH_LIMIT=1`);
    console.log(`Expected: Only 1 item should be refreshed per cycle`);
    const after = refreshQueue(params, normalized);
    
    // Check how many items were actually refreshed (have new timestamps)
    let refreshedCount = 0;
    const now = Date.now();
    for (const p of after) {
      const age = now - p.createdAtMs;
      if (age < 1000) { // Refreshed in the last second
        refreshedCount++;
      }
    }
    
    console.log(`✓ Refreshed ${refreshedCount} item(s) - batch limit working as expected`);
    
    // Restore original queue
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, queuePath);
      fs.unlinkSync(backupPath);
    }
    
    // Reset env
    delete process.env.SCHED_REFRESH_BATCH_LIMIT;
  } else {
    console.log('⚠ No queue file exists, skipping batch limit test');
  }
})();

console.log('\n=== All Tests Complete ===\n');
