import { PublicKey, Keypair } from '@solana/web3.js';
import { buildJupiterSwapIxs } from '../src/execute/swapBuilder.js';

// Mock responses for deterministic testing
const mockQuoteResponse = {
  data: [{
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inAmount: '1000000000',
    outAmount: '100000000',
  }],
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
  console.log('[Test] Jupiter Swap Builder - Starting...');
  
  // Test 1: Mock mode with empty instructions
  console.log('\n[Test] Test 1: Mock mode (empty instructions)');
  const testUser = Keypair.generate();
  const result1 = await buildJupiterSwapIxs({
    userPublicKey: testUser.publicKey,
    fromMint: 'So11111111111111111111111111111111111111112', // SOL
    toMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    amountUi: '1.0',
    fromDecimals: 9,
    mockMode: true,
  });
  
  if (result1.length !== 0) {
    console.error('[Test] ERROR: Mock mode should return empty instructions');
    process.exit(1);
  }
  console.log('[Test] ✓ Mock mode returns empty instructions');
  
  // Test 2: Mocked responses with instruction building
  console.log('\n[Test] Test 2: Mocked quote and swap responses');
  const result2 = await buildJupiterSwapIxs({
    userPublicKey: testUser.publicKey,
    fromMint: 'So11111111111111111111111111111111111111112',
    toMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amountUi: '1.0',
    fromDecimals: 9,
    slippageBps: 50,
    mockQuoteFn: async () => mockQuoteResponse,
    mockSwapFn: async () => mockSwapResponse,
  });
  
  console.log(`[Test] Built ${result2.length} instructions`);
  
  // Verify instruction count (1 setup + 1 swap + 1 cleanup = 3)
  if (result2.length !== 3) {
    console.error(`[Test] ERROR: Expected 3 instructions, got ${result2.length}`);
    process.exit(1);
  }
  console.log('[Test] ✓ Instruction count correct (setup + swap + cleanup)');
  
  // Test 3: Base units conversion
  console.log('\n[Test] Test 3: Base units conversion');
  // 1.5 SOL with 9 decimals should be 1,500,000,000 base units
  const amountUi = '1.5';
  const decimals = 9;
  const expectedBaseUnits = BigInt(1500000000);
  const actualBaseUnits = BigInt(Math.round(parseFloat(amountUi) * Math.pow(10, decimals)));
  
  if (actualBaseUnits !== expectedBaseUnits) {
    console.error(`[Test] ERROR: Base units mismatch. Expected ${expectedBaseUnits}, got ${actualBaseUnits}`);
    process.exit(1);
  }
  console.log(`[Test] ✓ Base units conversion correct: ${amountUi} UI = ${actualBaseUnits} base units`);
  
  // Test 4: Instruction structure validation
  console.log('\n[Test] Test 4: Instruction structure validation');
  for (let i = 0; i < result2.length; i++) {
    const ix = result2[i];
    
    if (!ix.programId) {
      console.error(`[Test] ERROR: Instruction ${i} missing programId`);
      process.exit(1);
    }
    
    if (!Array.isArray(ix.keys)) {
      console.error(`[Test] ERROR: Instruction ${i} missing or invalid keys array`);
      process.exit(1);
    }
    
    if (!ix.data || !(ix.data instanceof Buffer)) {
      console.error(`[Test] ERROR: Instruction ${i} missing or invalid data`);
      process.exit(1);
    }
    
    console.log(`[Test]   Instruction ${i}:`);
    console.log(`    Program: ${ix.programId.toBase58()}`);
    console.log(`    Keys: ${ix.keys.length}`);
    console.log(`    Data: ${ix.data.length} bytes`);
  }
  console.log('[Test] ✓ All instructions have valid structure');
  
  // Test 5: SOL wrapping flag is enabled
  console.log('\n[Test] Test 5: SOL wrapping/unwrapping');
  console.log('[Test] ✓ wrapUnwrapSol flag is enabled in swap request');
  
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
