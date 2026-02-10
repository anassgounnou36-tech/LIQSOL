import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction } from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';

/**
 * Test seized delta estimator with mocked simulation
 */

async function main() {
  console.log('[Test] Seized Delta Estimator - Starting...\n');
  
  // Mock connection that returns simulated account data
  const mockConnection = {
    async getAccountInfo(pubkey: PublicKey) {
      // Mock: collateral ATA exists with pre-balance of 1000 base units
      const accountData = Buffer.alloc(165);
      AccountLayout.encode({
        mint: new PublicKey('So11111111111111111111111111111111111111112'),
        owner: new PublicKey('11111111111111111111111111111111'),
        amount: 1000n, // pre-balance
        delegateOption: 0,
        delegate: new PublicKey('11111111111111111111111111111111'),
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: new PublicKey('11111111111111111111111111111111'),
      }, accountData);
      
      return {
        data: accountData,
        executable: false,
        lamports: 2039280,
        owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        rentEpoch: 0,
      };
    },
    
    async simulateTransaction(tx: VersionedTransaction, opts?: any) {
      // Mock: post-balance is 5000 base units (seized 4000)
      const accountData = Buffer.alloc(165);
      AccountLayout.encode({
        mint: new PublicKey('So11111111111111111111111111111111111111112'),
        owner: new PublicKey('11111111111111111111111111111111'),
        amount: 5000n, // post-balance (gained 4000)
        delegateOption: 0,
        delegate: new PublicKey('11111111111111111111111111111111'),
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: new PublicKey('11111111111111111111111111111111'),
      }, accountData);
      
      return {
        context: { slot: 12345 },
        value: {
          err: null,
          logs: ['Program log: liquidate success'],
          unitsConsumed: 50000,
          accounts: [
            {
              data: [accountData.toString('base64'), 'base64'],
            },
          ],
        },
      };
    },
  } as unknown as Connection;
  
  // Test 1: Successful seized delta estimation
  console.log('[Test] Test 1: Successful seized delta estimation');
  
  const { estimateSeizedCollateralDeltaBaseUnits } = await import('../src/execute/seizedDeltaEstimator.js');
  
  const testKeypair = Keypair.generate();
  const collateralMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL
  
  // Create a dummy transaction
  const dummyIx = new TransactionInstruction({
    keys: [],
    programId: new PublicKey('11111111111111111111111111111111'),
    data: Buffer.from([]),
  });
  
  const msg = new TransactionMessage({
    payerKey: testKeypair.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [dummyIx],
  });
  const compiledMsg = msg.compileToLegacyMessage();
  const simulateTx = new VersionedTransaction(compiledMsg);
  simulateTx.sign([testKeypair]);
  
  try {
    const seized = await estimateSeizedCollateralDeltaBaseUnits({
      connection: mockConnection,
      liquidator: testKeypair.publicKey,
      collateralMint,
      simulateTx,
    });
    
    console.log(`[Test]   Seized: ${seized} base units`);
    
    // Expected: 5000 - 1000 = 4000
    const expected = 4000n;
    if (seized === expected) {
      console.log('[Test] ✓ Seized delta correct');
    } else {
      console.error(`[Test] ERROR: Expected ${expected}, got ${seized}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('[Test] ERROR:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  
  // Test 2: Zero delta (should throw)
  console.log('\n[Test] Test 2: Zero delta (should throw)');
  
  const mockConnectionZeroDelta = {
    async getAccountInfo() {
      const accountData = Buffer.alloc(165);
      AccountLayout.encode({
        mint: new PublicKey('So11111111111111111111111111111111111111112'),
        owner: new PublicKey('11111111111111111111111111111111'),
        amount: 1000n,
        delegateOption: 0,
        delegate: new PublicKey('11111111111111111111111111111111'),
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: new PublicKey('11111111111111111111111111111111'),
      }, accountData);
      
      return {
        data: accountData,
        executable: false,
        lamports: 2039280,
        owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        rentEpoch: 0,
      };
    },
    
    async simulateTransaction() {
      // Mock: post-balance same as pre-balance (no delta)
      const accountData = Buffer.alloc(165);
      AccountLayout.encode({
        mint: new PublicKey('So11111111111111111111111111111111111111112'),
        owner: new PublicKey('11111111111111111111111111111111'),
        amount: 1000n, // same as pre
        delegateOption: 0,
        delegate: new PublicKey('11111111111111111111111111111111'),
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: new PublicKey('11111111111111111111111111111111'),
      }, accountData);
      
      return {
        context: { slot: 12345 },
        value: {
          err: null,
          logs: [],
          accounts: [{ data: [accountData.toString('base64'), 'base64'] }],
        },
      };
    },
  } as unknown as Connection;
  
  try {
    await estimateSeizedCollateralDeltaBaseUnits({
      connection: mockConnectionZeroDelta,
      liquidator: testKeypair.publicKey,
      collateralMint,
      simulateTx,
    });
    
    console.error('[Test] ERROR: Should have thrown on zero delta');
    process.exit(1);
  } catch (err) {
    if (err instanceof Error && err.message.includes('no collateral delta')) {
      console.log('[Test] ✓ Correctly threw on zero delta');
    } else {
      console.error('[Test] ERROR: Wrong error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  
  // Test 3: Account doesn't exist (pre-balance = 0)
  console.log('\n[Test] Test 3: Account doesn\'t exist (pre-balance = 0)');
  
  const mockConnectionNoAccount = {
    async getAccountInfo() {
      return null; // Account doesn't exist
    },
    
    async simulateTransaction() {
      // Mock: post-balance is 2000 (seized 2000 from scratch)
      const accountData = Buffer.alloc(165);
      AccountLayout.encode({
        mint: new PublicKey('So11111111111111111111111111111111111111112'),
        owner: new PublicKey('11111111111111111111111111111111'),
        amount: 2000n,
        delegateOption: 0,
        delegate: new PublicKey('11111111111111111111111111111111'),
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: new PublicKey('11111111111111111111111111111111'),
      }, accountData);
      
      return {
        context: { slot: 12345 },
        value: {
          err: null,
          logs: [],
          accounts: [{ data: [accountData.toString('base64'), 'base64'] }],
        },
      };
    },
  } as unknown as Connection;
  
  try {
    const seized = await estimateSeizedCollateralDeltaBaseUnits({
      connection: mockConnectionNoAccount,
      liquidator: testKeypair.publicKey,
      collateralMint,
      simulateTx,
    });
    
    console.log(`[Test]   Seized: ${seized} base units`);
    
    // Expected: 2000 - 0 = 2000
    const expected = 2000n;
    if (seized === expected) {
      console.log('[Test] ✓ Seized delta correct (from zero pre-balance)');
    } else {
      console.error(`[Test] ERROR: Expected ${expected}, got ${seized}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('[Test] ERROR:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  
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
