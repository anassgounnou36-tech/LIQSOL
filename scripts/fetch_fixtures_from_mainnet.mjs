#!/usr/bin/env node
/**
 * Fetches real Reserve and Obligation account data from Solana mainnet
 * and creates valid test fixtures that can be decoded by the existing decoders.
 * 
 * Usage:
 *   node scripts/fetch_fixtures_from_mainnet.mjs
 * 
 * Requirements:
 *   - Network access to Solana RPC (mainnet-beta)
 *   - The specified accounts must exist on-chain
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

// Configuration
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const RESERVE_PUBKEY = 'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q'; // Kamino USDC Reserve
const FIXTURES_DIR = 'test/fixtures';

// For Obligation, we'd need to find one with actual debt. For now, provide placeholder
const OBLIGATION_PUBKEY_EXAMPLE = '11111111111111111111111111111114';

console.log('=== Fetching Real Account Data from Solana Mainnet ===\n');
console.log(`RPC Endpoint: ${RPC_ENDPOINT}`);
console.log(`Target Reserve: ${RESERVE_PUBKEY}`);

async function fetchReserveFixture() {
  try {
    console.log('\n[1/2] Fetching Reserve account...');
    const connection = new Connection(RPC_ENDPOINT, 'confirmed');
    const reservePubkey = new PublicKey(RESERVE_PUBKEY);
    
    const accountInfo = await connection.getAccountInfo(reservePubkey);
    
    if (!accountInfo) {
      console.error('✗ Reserve account not found');
      return null;
    }
    
    console.log(`✓ Fetched Reserve account (${accountInfo.data.length} bytes)`);
    
    const fixture = {
      pubkey: RESERVE_PUBKEY,
      note: "Real USDC Reserve from Kamino Main Market for testing",
      data_base64: accountInfo.data.toString('base64'),
      expected: {
        market: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        liquidityMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    };
    
    const outputPath = join(FIXTURES_DIR, 'reserve_usdc.json');
    writeFileSync(outputPath, JSON.stringify(fixture, null, 2));
    console.log(`✓ Saved to ${outputPath}`);
    
    return fixture;
  } catch (error) {
    console.error(`✗ Error fetching Reserve: ${error.message}`);
    return null;
  }
}

async function fetchObligationFixture() {
  try {
    console.log('\n[2/2] Fetching Obligation account...');
    console.log('Note: Finding an Obligation with active debt requires scanning.');
    console.log('For this example, provide a known Obligation pubkey or scan getProgramAccounts');
    
    // This would require:
    // 1. Scanning for obligations using getProgramAccounts
    // 2. Filtering for obligations with hasDebt = 1 and USDC borrows
    // 3. Selecting one to use as fixture
    
    console.log('⚠️  Obligation fetching not implemented - requires account scanning');
    console.log('   To complete: provide a known Obligation pubkey with USDC debt');
    
    // Create placeholder fixture with instructions
    const fixture = {
      pubkey: OBLIGATION_PUBKEY_EXAMPLE,
      note: "Obligation with debt - needs real account data",
      data_base64: "FETCH_REAL_DATA_WITH_NETWORK_ACCESS",
      expected: {
        market: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
      },
      _instructions: "Replace pubkey with real Obligation address and fetch using Connection.getAccountInfo()",
    };
    
    const outputPath = join(FIXTURES_DIR, 'obligation_usdc_debt.json');
    writeFileSync(outputPath, JSON.stringify(fixture, null, 2));
    console.log(`✓ Saved placeholder to ${outputPath}`);
    
    return fixture;
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    return null;
  }
}

async function main() {
  const results = {
    reserve: await fetchReserveFixture(),
    obligation: await fetchObligationFixture(),
  };
  
  console.log('\n=== Summary ===');
  console.log(`Reserve: ${results.reserve ? '✓ Success' : '✗ Failed'}`);
  console.log(`Obligation: ${results.obligation ? '⚠️  Placeholder' : '✗ Failed'}`);
  
  if (!results.reserve) {
    console.log('\n⚠️  Failed to fetch Reserve data.');
    console.log('This is likely due to network connectivity or RPC rate limiting.');
    console.log('Try again with a different RPC endpoint or check network access.');
    process.exit(1);
  }
  
  console.log('\n✓ Fixtures generated successfully!');
  console.log('\nNext steps:');
  console.log('1. For Obligation: Find a real obligation address with USDC debt');
  console.log('2. Update scripts/fetch_fixtures_from_mainnet.mjs with the address');
  console.log('3. Re-run this script to fetch real Obligation data');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
