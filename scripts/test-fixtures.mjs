import { readFileSync } from 'fs';
import { PublicKey } from '@solana/web3.js';
import { decodeReserve, decodeObligation } from '../src/kamino/decoder.js';

// Test reserve fixture
try {
  const reserveFixture = JSON.parse(readFileSync('test/fixtures/reserve_usdc.json', 'utf-8'));
  const reserveData = Buffer.from(reserveFixture.data_base64, 'base64');
  const reservePubkey = new PublicKey(reserveFixture.pubkey);
  
  console.log('=== Reserve Fixture ===');
  console.log('Pubkey:', reserveFixture.pubkey);
  console.log('Data length:', reserveData.length);
  
  const decoded = decodeReserve(reserveData, reservePubkey);
  console.log('Decoded successfully!');
  console.log('Market:', decoded.marketPubkey);
  console.log('Liquidity Mint:', decoded.liquidityMint);
  console.log('Collateral Mint:', decoded.collateralMint);
  console.log('Liquidity Decimals:', decoded.liquidityDecimals);
  console.log('Collateral Decimals:', decoded.collateralDecimals);
  console.log('Expected market:', reserveFixture.expected?.market);
  console.log('Expected liquidityMint:', reserveFixture.expected?.liquidityMint);
  
  // Verify expectations
  if (reserveFixture.expected?.market && decoded.marketPubkey !== reserveFixture.expected.market) {
    console.error('Market mismatch!');
  }
  if (reserveFixture.expected?.liquidityMint && decoded.liquidityMint !== reserveFixture.expected.liquidityMint) {
    console.error('Liquidity mint mismatch!');
  }
} catch (error) {
  console.error('Failed to decode reserve:', error.message);
}

console.log('\n');

// Test obligation fixture
try {
  const obligationFixture = JSON.parse(readFileSync('test/fixtures/obligation_usdc_debt.json', 'utf-8'));
  const obligationData = Buffer.from(obligationFixture.data_base64, 'base64');
  const obligationPubkey = new PublicKey(obligationFixture.pubkey);
  
  console.log('=== Obligation Fixture ===');
  console.log('Pubkey:', obligationFixture.pubkey);
  console.log('Data length:', obligationData.length);
  
  const decoded = decodeObligation(obligationData, obligationPubkey);
  console.log('Decoded successfully!');
  console.log('Market:', decoded.marketPubkey);
  console.log('Owner:', decoded.ownerPubkey);
  console.log('Deposits:', decoded.deposits.length);
  console.log('Borrows:', decoded.borrows.length);
  console.log('Expected market:', obligationFixture.expected?.market);
  
  // Verify expectations
  if (obligationFixture.expected?.market && decoded.marketPubkey !== obligationFixture.expected.market) {
    console.error('Market mismatch!');
  }
} catch (error) {
  console.error('Failed to decode obligation:', error.message);
}
