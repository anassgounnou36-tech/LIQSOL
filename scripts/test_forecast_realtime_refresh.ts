import { YellowstoneAccountListener } from '../src/monitoring/yellowstoneAccountListener.js';
import { YellowstonePriceListener } from '../src/monitoring/yellowstonePriceListener.js';
import { EventRefreshOrchestrator } from '../src/monitoring/eventRefreshOrchestrator.js';
import { loadQueue } from '../src/scheduler/txScheduler.js';

(async () => {
  console.log('Starting real-time refresh test (simulated events)...');

  const accountListener = new YellowstoneAccountListener({
    grpcEndpoint: 'simulated',
    obligationPubkeys: ['kgpZaovQNKALCNyxUFuoPj4kSqm6YQz5H4qXgM5p61d'],
  });
  const priceListener = new YellowstonePriceListener({
    grpcEndpoint: 'simulated',
    assetMints: ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  });

  const orchestrator = new EventRefreshOrchestrator({
    minPricePctChange: 0.5, // 0.5% threshold for test
    minHealthDelta: 0.005,
    minRefreshIntervalMs: 500,
  });

  accountListener.on('account-update', ev => orchestrator.handleAccountUpdate(ev));
  priceListener.on('price-update', ev => orchestrator.handlePriceUpdate(ev));

  await accountListener.start();
  await priceListener.start();

  const before = loadQueue().find(p => p.key === 'kgpZaovQNKALCNyxUFuoPj4kSqm6YQz5H4qXgM5p61d');
  console.log('Before refresh (top obligation):', before ? { key: before.key, ev: before.ev, ttlMin: before.ttlMin, hazard: before.hazard } : 'not-found');

  // Simulate account change: health ratio drop
  accountListener.simulateAccountUpdate({
    pubkey: 'kgpZaovQNKALCNyxUFuoPj4kSqm6YQz5H4qXgM5p61d',
    slot: 123,
    before: { healthRatio: 0.85 },
    after: { healthRatio: 0.80 },
  });

  // Simulate price update: SOL -2%
  priceListener.simulatePriceUpdate({
    assetMint: 'So11111111111111111111111111111111111111112',
    slot: 124,
    price: 95,
    prevPrice: 96.94,
  });

  // Read after updates
  const after = loadQueue().find(p => p.key === 'kgpZaovQNKALCNyxUFuoPj4kSqm6YQz5H4qXgM5p61d');
  console.log('After refresh (top obligation):', after ? { key: after.key, ev: after.ev, ttlMin: after.ttlMin, hazard: after.hazard } : 'not-found');

  console.log('Test complete.');
})();
