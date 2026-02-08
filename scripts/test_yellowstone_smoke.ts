import { loadReadonlyEnv } from '../src/config/env.js';
import { createYellowstoneClient } from '../src/yellowstone/client.js';
import { PublicKey } from '@solana/web3.js';

// CommitmentLevel enum values from @triton-one/yellowstone-grpc
const CommitmentLevel = {
  PROCESSED: 0,
  CONFIRMED: 1,
  FINALIZED: 2,
} as const;

async function main() {
  console.log('[Smoke] Starting Yellowstone SLOT + optional account stream test...');

  const env = loadReadonlyEnv();
  const url = env.YELLOWSTONE_GRPC_URL;
  const token = env.YELLOWSTONE_X_TOKEN;
  const accountPubkey = process.env.SMOKE_TEST_ACCOUNT_PUBKEY || '';

  if (!url) {
    console.error('[Smoke] ERROR: Missing YELLOWSTONE_GRPC_URL');
    process.exit(1);
  }

  console.log('[Smoke] Connecting to Yellowstone gRPC:', url);
  if (accountPubkey) {
    console.log('[Smoke] Will also test account subscription for:', accountPubkey);
  }

  let client;
  try {
    client = await createYellowstoneClient(url, token);
    console.log('[Smoke] Client connected successfully');
  } catch (err) {
    console.error('[Smoke] ERROR: Failed to connect client:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const timeoutMs = 10000;
  let resolved = false;
  let slotReceived = false;
  let accountReceived = false;

  const timer = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    console.error('[Smoke] ERROR: Timeout - no updates received within 10s');
    process.exit(1);
  }, timeoutMs);

  function checkSuccess() {
    if (resolved) return;
    // Succeed if we got a slot update (primary test)
    // Account test is optional - if pubkey provided and we got it, great; if not provided, slot is enough
    if (slotReceived) {
      resolved = true;
      clearTimeout(timer);
      if (accountPubkey && accountReceived) {
        console.log('[Smoke] ✓ Received both slot and account updates. Test PASSED.');
      } else if (accountPubkey && !accountReceived) {
        console.log('[Smoke] ✓ Received slot update (account not yet received but test passes on slot alone). Test PASSED.');
      } else {
        console.log('[Smoke] ✓ Received slot update. Test PASSED.');
      }
      process.exit(0);
    }
  }

  // Subscribe to slots stream (deterministic frequent updates)
  console.log('[Smoke] Subscribing to SLOT stream...');
  
  const slotRequest = {
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

  let slotStream;
  try {
    slotStream = await client.subscribe();
    
    slotStream.on('data', (data: any) => {
      if (data.slot) {
        console.log('[Smoke] Received slot:', data.slot.slot);
        slotReceived = true;
        checkSuccess();
      }
    });

    slotStream.on('error', (err: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      console.error('[Smoke] ERROR: Slot stream error:', err.message);
      process.exit(1);
    });

    slotStream.write(slotRequest);
    console.log('[Smoke] Slot subscription request sent');
  } catch (err) {
    console.error('[Smoke] ERROR: Failed to create slot stream:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Optionally subscribe to one explicit account pubkey to validate account pipeline
  if (accountPubkey) {
    console.log('[Smoke] Subscribing to account:', accountPubkey);
    
    try {
      // Validate pubkey format
      new PublicKey(accountPubkey);
      
      const accountRequest = {
        commitment: CommitmentLevel.CONFIRMED,
        accounts: {
          test_account: {
            account: [accountPubkey],
          },
        },
        slots: {},
        accountsDataSlice: [],
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
      };

      const accountStream = await client.subscribe();
      
      accountStream.on('data', (data: any) => {
        if (data.account) {
          console.log('[Smoke] Received account update at slot:', Number(data.account.slot ?? 0));
          accountReceived = true;
          checkSuccess();
        }
      });

      accountStream.on('error', (err: Error) => {
        console.error('[Smoke] WARNING: Account stream error (non-fatal):', err.message);
        // Don't fail the whole test - slot stream is primary
      });

      accountStream.write(accountRequest);
      console.log('[Smoke] Account subscription request sent');
    } catch (err) {
      console.error('[Smoke] WARNING: Failed to setup account stream (non-fatal):', err instanceof Error ? err.message : String(err));
      // Don't fail - slot test is sufficient
    }
  }
}

main().catch(err => {
  console.error('[Smoke] ERROR: Unhandled exception:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
