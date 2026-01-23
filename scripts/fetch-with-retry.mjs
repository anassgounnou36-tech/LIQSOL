import { Connection, PublicKey } from '@solana/web3.js';
import { writeFileSync } from 'fs';

async function fetchWithRetry(url, maxRetries = 3) {
  const connection = new Connection(url, {
    commitment: 'confirmed',
    httpHeaders: { 'Content-Type': 'application/json' }
  });
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`Attempt ${i + 1}/${maxRetries}...`);
      return await connection.getAccountInfo(new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q'));
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  throw new Error('All retries failed');
}

// Try multiple RPC endpoints
const endpoints = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://rpc.ankr.com/solana',
];

for (const endpoint of endpoints) {
  try {
    console.log(`\nTrying ${endpoint}...`);
    const accountInfo = await fetchWithRetry(endpoint);
    if (accountInfo) {
      console.log('Success! Data length:', accountInfo.data.length);
      const fixture = {
        pubkey: 'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q',
        data_base64: Buffer.from(accountInfo.data).toString('base64'),
        expected: {
          market: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
          liquidityMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        }
      };
      writeFileSync('test/fixtures/reserve_usdc.json', JSON.stringify(fixture, null, 2));
      console.log('Saved to test/fixtures/reserve_usdc.json');
      break;
    }
  } catch (error) {
    console.error(`Failed with ${endpoint}:`, error.message);
  }
}
