import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import { buildJupiterSwapIxs, formatBaseUnitsToUiString } from '../src/execute/swapBuilder.js';

// Mock responses for deterministic testing (for legacy tests)
const mockQuoteResponse = {
  data: [{
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inAmount: '1000000000',
    outAmount: '100000000',
  }],
  outAmount: '100000000',
};

const mockSwapResponse = {
  setupInstructions: [
    {
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      accounts: [
        { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: true },
      ],
      data: 'AQAAAA==', // base64 encoded data
    },
  ],
  swapInstruction: {
    programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    accounts: [
      { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
    ],
    data: 'AgAAAA==',
  },
  cleanupInstruction: {
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    accounts: [
      { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: true },
    ],
    data: 'AwAAAA==',
  },
};

async function main() {
  console.log('[Test] Jupiter Swap Builder - Starting...\n');
  
  // Test 1: Base-units API with mocked fetch
  console.log('[Test] Test 1: Base-units API (new)');
  const testUser = Keypair.generate();
  const mockConnection = {} as Connection;
  
  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    
    // Check method for swap-instructions (it's a POST)
    if (urlStr.includes('/swap-instructions')) {
      return {
        ok: true,
        json: async () => mockSwapResponse,
      } as Response;
    } else if (urlStr.includes('/quote')) {
      const result = {
        data: [{ /* route object - any truthy value works */ valid: true }],
        outAmount: '100000000',
      };
      return {
        ok: true,
        json: async () => result,
      } as Response;
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  };
  
  const result1 = await buildJupiterSwapIxs({
    inputMint: new PublicKey('So11111111111111111111111111111111111111112'), // SOL
    outputMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC
    inAmountBaseUnits: 1500000000n, // 1.5 SOL in base units (9 decimals)
    slippageBps: 100,
    userPubkey: testUser.publicKey,
    connection: mockConnection,
    fetchFn: mockFetch as typeof fetch,
  });
  
  console.log(`[Test]   Setup: ${result1.setupIxs.length}, Swap: ${result1.swapIxs.length}, Cleanup: ${result1.cleanupIxs.length}`);
  
  // Verify instruction counts (should be 1 setup, 1 swap, 1 cleanup since we have all in mockSwapResponse)
  if (result1.setupIxs.length !== 1 || result1.swapIxs.length !== 1 || result1.cleanupIxs.length !== 1) {
    console.error(`[Test] ERROR: Expected 1 setup, 1 swap, 1 cleanup; got ${result1.setupIxs.length}, ${result1.swapIxs.length}, ${result1.cleanupIxs.length}`);
    process.exit(1);
  }
  console.log('[Test] ✓ Base-units API returns correct structure');
  
  // Verify estimatedOutAmountBaseUnits is parsed as bigint
  if (result1.estimatedOutAmountBaseUnits !== 100000000n) {
    console.error(`[Test] ERROR: Expected estimatedOutAmountBaseUnits = 100000000n, got ${result1.estimatedOutAmountBaseUnits}`);
    process.exit(1);
  }
  console.log('[Test] ✓ estimatedOutAmountBaseUnits parsed as bigint');
  
  // Test 2: formatBaseUnitsToUiString
  console.log('\n[Test] Test 2: formatBaseUnitsToUiString');
  
  const testCases: Array<{ amount: bigint; decimals: number; expected: string }> = [
    { amount: 1500000000n, decimals: 9, expected: '1.5' }, // 1.5 SOL
    { amount: 100500000n, decimals: 6, expected: '100.5' }, // 100.5 USDC
    { amount: 100000000n, decimals: 6, expected: '100' }, // 100 USDC (no fractional)
    { amount: 1000000n, decimals: 6, expected: '1' }, // 1 USDC
    { amount: 1000001n, decimals: 6, expected: '1.000001' }, // 1.000001 USDC
    { amount: 0n, decimals: 9, expected: '0' }, // 0
  ];
  
  for (const tc of testCases) {
    const result = formatBaseUnitsToUiString(tc.amount, tc.decimals);
    if (result !== tc.expected) {
      console.error(`[Test] ERROR: formatBaseUnitsToUiString(${tc.amount}, ${tc.decimals}) = ${result}, expected ${tc.expected}`);
      process.exit(1);
    }
  }
  console.log('[Test] ✓ formatBaseUnitsToUiString correct for all test cases');
  
  // Test 3: No Number conversions (bigint → string only)
  console.log('\n[Test] Test 3: Verify no Number conversions in base-units flow');
  
  const largeAmount = 999999999999999999n; // Very large amount that would lose precision as Number
  
  const mockFetchLarge = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    
    // Check for swap-instructions first (POST request)
    if (urlStr.includes('/swap-instructions')) {
      return {
        ok: true,
        json: async () => mockSwapResponse,
      } as Response;
    } else if (urlStr.includes('/quote')) {
      // Verify amount is passed as string
      try {
        const urlObj = new URL(urlStr);
        const amountParam = urlObj.searchParams.get('amount');
        if (amountParam !== largeAmount.toString()) {
          console.error(`[Test] ERROR: Amount not passed as string correctly: ${amountParam} vs ${largeAmount.toString()}`);
          process.exit(1);
        }
      } catch (err) {
        console.error('[Test] ERROR: Failed to parse URL:', err);
        process.exit(1);
      }
      return {
        ok: true,
        json: async () => ({
          data: [{ valid: true }],
          outAmount: '100000000',
        }),
      } as Response;
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  };
  
  await buildJupiterSwapIxs({
    inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
    outputMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    inAmountBaseUnits: largeAmount,
    slippageBps: 100,
    userPubkey: testUser.publicKey,
    connection: mockConnection,
    fetchFn: mockFetchLarge as typeof fetch,
  });
  
  console.log('[Test] ✓ Large amounts passed as string (no Number conversion)');
  
  // Test 4: Instruction structure validation
  console.log('\n[Test] Test 4: Instruction structure validation');
  for (const ix of [...result1.setupIxs, ...result1.swapIxs, ...result1.cleanupIxs]) {
    if (!ix.programId) {
      console.error(`[Test] ERROR: Instruction missing programId`);
      process.exit(1);
    }
    
    if (!Array.isArray(ix.keys)) {
      console.error(`[Test] ERROR: Instruction missing or invalid keys array`);
      process.exit(1);
    }
    
    if (!ix.data || !(ix.data instanceof Buffer)) {
      console.error(`[Test] ERROR: Instruction missing or invalid data`);
      process.exit(1);
    }
  }
  console.log('[Test] ✓ All instructions have valid structure');
  
  console.log('\n[Test] All tests PASSED');
  process.exit(0);
}

main().catch(err => {
  console.error('[Test] FATAL:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error('[Test] Stack:', err.stack);
  }
  process.exit(1);
});
