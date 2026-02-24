import { YellowstoneAccountListener } from '../src/monitoring/yellowstoneAccountListener.js';
import { YellowstonePriceListener } from '../src/monitoring/yellowstonePriceListener.js';
import { EventRefreshOrchestrator } from '../src/monitoring/eventRefreshOrchestrator.js';
import { loadQueue } from '../src/scheduler/txScheduler.js';

(async () => {
  console.log('Starting real-time refresh test (simulated events)...');

  // Create listeners but don't start them (to avoid connection errors in test mode)
  const accountListener = new YellowstoneAccountListener({
    grpcUrl: 'simulated',
    accountPubkeys: ['kgpZaovQNKALCNyxUFuoPj4kSqm6YQz5H4qXgM5p61d'],
  });
  const priceListener = new YellowstonePriceListener({
    grpcUrl: 'simulated',
    oraclePubkeys: ['oracle1', 'oracle2'],
  });

  const orchestrator = new EventRefreshOrchestrator({
    minPricePctChange: 0.5, // 0.5% threshold for test
    minHealthDelta: 0.005,
    minRefreshIntervalMs: 500,
  }, () => undefined);

  accountListener.on('account-update', ev => orchestrator.handleAccountUpdate(ev));
  priceListener.on('price-update', ev => {
    if (ev.mint) orchestrator.handleMintUpdate(ev.mint);
  });

  // No need to await start() in test mode - we simulate events directly
  // await accountListener.start();
  // await priceListener.start();

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
    oraclePubkey: 'oracle1',
    slot: 124,
    mint: 'So11111111111111111111111111111111111111112',
    price: 95,
    prevPrice: 96.94,
  });

  // Wait a bit for async processing
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Read after updates
  const after = loadQueue().find(p => p.key === 'kgpZaovQNKALCNyxUFuoPj4kSqm6YQz5H4qXgM5p61d');
  console.log('After refresh (top obligation):', after ? { key: after.key, ev: after.ev, ttlMin: after.ttlMin, hazard: after.hazard } : 'not-found');

  console.log('Test complete.');
})();
