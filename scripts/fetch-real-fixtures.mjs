import { Connection, PublicKey } from '@solana/web3.js';
import { writeFileSync } from 'fs';

async function fetchFixture(pubkey, outputName, expectedMarket, expectedMint) {
  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  console.log('Fetching account:', pubkey);
  
  const accountInfo = await connection.getAccountInfo(new PublicKey(pubkey));
  if (!accountInfo) {
    console.error('Account not found');
    process.exit(1);
  }
  
  const fixture = {
    pubkey: pubkey,
    data_base64: Buffer.from(accountInfo.data).toString('base64'),
    expected: {
      market: expectedMarket,
    }
  };
  
  if (expectedMint) {
    fixture.expected.liquidityMint = expectedMint;
  }
  
  writeFileSync('test/fixtures/' + outputName + '.json', JSON.stringify(fixture, null, 2));
  console.log('Fixture saved to test/fixtures/' + outputName + '.json');
  console.log('Data length:', accountInfo.data.length);
}

// Fetch USDC Reserve
await fetchFixture(
  'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q',
  'reserve_usdc',
  '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
);

// Fetch Obligation
await fetchFixture(
  'H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo',
  'obligation_usdc_debt',
  '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
  null
);

console.log('All fixtures fetched successfully!');
