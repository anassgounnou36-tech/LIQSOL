import { loadReadonlyEnv } from '../src/config/env.js';
import { createYellowstoneClient } from '../src/yellowstone/client.js';

// CommitmentLevel enum values from @triton-one/yellowstone-grpc
const CommitmentLevel = {
  PROCESSED: 0,
  CONFIRMED: 1,
  FINALIZED: 2,
} as const;

async function main() {
  console.log('[Smoke] Starting Yellowstone SLOT stream test...');

  const env = loadReadonlyEnv();
  const url = env.YELLOWSTONE_GRPC_URL;
  const token = env.YELLOWSTONE_X_TOKEN;

  if (!url) {
    console.error('[Smoke] ERROR: Missing YELLOWSTONE_GRPC_URL');
    process.exit(1);
  }

  console.log('[Smoke] Connecting to Yellowstone gRPC:', url);

  let client;
  try {
    client = await createYellowstoneClient(url, token);
    console.log('[Smoke] Client connected successfully');
  } catch (err) {
    console.error('[Smoke] ERROR: Failed to connect client:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Subscribe to slots stream
  console.log('[Smoke] Subscribing to SLOT stream...');

  const request = {
    commitment: CommitmentLevel.CONFIRMED,
    accounts: {},
    slots: {
      slots: {},
    },
    accountsDataSlice: [],
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
  };

  let stream;
  try {
    stream = await client.subscribe();
  } catch (err) {
    console.error('[Smoke] ERROR: Failed to create stream:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const timeoutMs = 10000;
  let resolved = false;

  const timer = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    console.error('[Smoke] ERROR: Timeout - no slot update received within 10s');
    stream.destroy();
    process.exit(1);
  }, timeoutMs);

  function success() {
    if (resolved) return;
    resolved = true;
    clearTimeout(timer);
    console.log('[Smoke] ✓ Received slot update. Test PASSED.');
    stream.destroy();
    process.exit(0);
  }

  stream.on('data', (data: any) => {
    if (data.slot) {
      console.log('[Smoke] Received slot:', data.slot.slot);
      success();
    }
  });

  stream.on('error', (err: Error) => {
    if (resolved) return;
    resolved = true;
    clearTimeout(timer);
    console.error('[Smoke] ERROR: Stream error:', err.message);
    process.exit(1);
  });

  stream.on('end', () => {
    if (resolved) return;
    resolved = true;
    clearTimeout(timer);
    console.error('[Smoke] ERROR: Stream ended before receiving slot update');
    process.exit(1);
  });

  // Write subscription request
  stream.write(request);
  console.log('[Smoke] Subscription request sent, waiting for slot...');
}

main().catch(err => {
  console.error('[Smoke] ERROR: Unhandled exception:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
