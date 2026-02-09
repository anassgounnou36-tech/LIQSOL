// Test sorting logic
import { enqueuePlans } from '../src/scheduler/txScheduler.js';
import fs from 'fs';
import path from 'path';

// Load test queue
const queuePath = path.join(process.cwd(), 'data', 'tx_queue.json');
const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));

console.log('Original order:');
queue.forEach((p: any, i: number) => {
  console.log(`  ${i+1}. ${p.key} - liq=${p.liquidationEligible ?? false}, ev=${p.ev}, ttl=${p.ttlMin}, hazard=${p.hazard}`);
});

// Sort using enqueuePlans (it will load and merge, then sort)
const sorted = enqueuePlans([]);

console.log('\nSorted order (liquidationEligible first):');
sorted.forEach((p: any, i: number) => {
  console.log(`  ${i+1}. ${p.key} - liq=${p.liquidationEligible ?? false}, ev=${p.ev}, ttl=${p.ttlMin}, hazard=${p.hazard}`);
});

// Verify: liquidatable ones should be first
const liquidatable = sorted.filter((p: any) => p.liquidationEligible);
const nonLiquidatable = sorted.filter((p: any) => !p.liquidationEligible);

console.log(`\n${liquidatable.length} liquidatable, ${nonLiquidatable.length} non-liquidatable`);

if (liquidatable.length === 0) {
  console.log('\n✓ No liquidatable obligations in queue');
} else if (nonLiquidatable.length === 0) {
  console.log('\n✓ All obligations are liquidatable');
} else {
  // Check that all liquidatable come before all non-liquidatable
  const firstLiqIdx = sorted.findIndex((p: any) => p.liquidationEligible);
  const lastLiqIdx = sorted.map((p: any, i: number) => p.liquidationEligible ? i : -1).filter((i: number) => i >= 0).pop();
  const firstNonLiqIdx = sorted.findIndex((p: any) => !p.liquidationEligible);
  
  if (lastLiqIdx !== undefined && lastLiqIdx < firstNonLiqIdx) {
    console.log('\n✓ PASS: All liquidatable obligations are sorted before non-liquidatable');
  } else {
    console.log('\n✗ FAIL: Liquidatable obligations are not properly sorted first');
    process.exit(1);
  }
}
