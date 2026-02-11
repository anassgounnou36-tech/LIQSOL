#!/usr/bin/env tsx
/**
 * Verify @solana/kit integration for Kamino SDK
 * Tests that the imports work and can create RPC objects
 */

async function main() {
  console.log('🔍 Testing @solana/kit integration for Kamino SDK...\n');

  try {
    // Test 1: Import check
    console.log('Test 1: Importing createSolanaRpc and address from @solana/kit');
    const { createSolanaRpc, address } = await import('@solana/kit');
    console.log('✅ Successfully imported functions\n');

    // Test 2: address() function
    console.log('Test 2: Testing address() function');
    const testAddress = "11111111111111111111111111111111";
    const addr = address(testAddress);
    console.log(`✅ address() works: ${addr}\n`);

    // Test 3: createSolanaRpc() function
    console.log('Test 3: Testing createSolanaRpc() function');
    const testRpcUrl = "https://api.mainnet-beta.solana.com";
    const rpc = createSolanaRpc(testRpcUrl);
    console.log(`✅ createSolanaRpc() works`);
    console.log(`   Has send() method: ${typeof rpc.send === 'function'}`);
    console.log(`   Has getAccountInfo() method: ${typeof rpc.getAccountInfo === 'function'}\n`);

    // Test 4: Verify no @solana/rpc imports in Kamino files
    console.log('Test 4: Verifying no @solana/rpc imports in Kamino integration files');
    const fs = await import('fs');
    const flashloanContent = fs.readFileSync('src/flashloan/kaminoFlashloan.ts', 'utf-8');
    const liquidationContent = fs.readFileSync('src/kamino/liquidationBuilder.ts', 'utf-8');
    
    const hasRpcImport = flashloanContent.includes('from "@solana/rpc"') || 
                         liquidationContent.includes('from "@solana/rpc"');
    const hasAddressImport = flashloanContent.includes('from "@solana/addresses"') || 
                             liquidationContent.includes('from "@solana/addresses"');
    const hasRpcAsAny = flashloanContent.includes('rpc as any') || 
                        liquidationContent.includes('rpc as any');
    
    if (hasRpcImport || hasAddressImport || hasRpcAsAny) {
      console.error('❌ Found forbidden imports or casts');
      console.error(`   @solana/rpc import: ${hasRpcImport}`);
      console.error(`   @solana/addresses import: ${hasAddressImport}`);
      console.error(`   rpc as any cast: ${hasRpcAsAny}`);
      process.exit(1);
    }
    
    const hasKitImport = flashloanContent.includes('from "@solana/kit"') && 
                         liquidationContent.includes('from "@solana/kit"');
    
    if (!hasKitImport) {
      console.error('❌ Missing @solana/kit imports in Kamino integration files');
      process.exit(1);
    }
    
    console.log('✅ Kamino integration files use @solana/kit correctly\n');

    console.log('✅ All @solana/kit integration tests passed!');
    console.log('   The Kamino SDK should now work correctly with @solana/kit RPC\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

main();
