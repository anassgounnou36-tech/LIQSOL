import { describe, it, expect } from 'vitest';
import { resolveMintFlexible, USDC_MINT, SOL_MINT, USDT_MINT, BTC_MINT } from '../solana/mint.js';
import { PublicKey } from '@solana/web3.js';

describe('resolveMintFlexible', () => {
  it('should resolve USDC symbol to pubkey', () => {
    const result = resolveMintFlexible('USDC');
    expect(result.toBase58()).toBe(USDC_MINT);
  });

  it('should resolve usdc (lowercase) to pubkey', () => {
    const result = resolveMintFlexible('usdc');
    expect(result.toBase58()).toBe(USDC_MINT);
  });

  it('should resolve SOL symbol to pubkey', () => {
    const result = resolveMintFlexible('SOL');
    expect(result.toBase58()).toBe(SOL_MINT);
  });

  it('should resolve USDT symbol to pubkey', () => {
    const result = resolveMintFlexible('USDT');
    expect(result.toBase58()).toBe(USDT_MINT);
  });

  it('should resolve BTC symbol to pubkey', () => {
    const result = resolveMintFlexible('BTC');
    expect(result.toBase58()).toBe(BTC_MINT);
  });

  it('should resolve USDC base58 pubkey to same pubkey', () => {
    const result = resolveMintFlexible(USDC_MINT);
    expect(result.toBase58()).toBe(USDC_MINT);
  });

  it('should resolve SOL base58 pubkey to same pubkey', () => {
    const result = resolveMintFlexible(SOL_MINT);
    expect(result.toBase58()).toBe(SOL_MINT);
  });

  it('should resolve arbitrary valid base58 pubkey', () => {
    const arbitraryPubkey = '11111111111111111111111111111111';
    const result = resolveMintFlexible(arbitraryPubkey);
    expect(result.toBase58()).toBe(arbitraryPubkey);
  });

  it('should throw error for invalid mint symbol', () => {
    expect(() => resolveMintFlexible('INVALID')).toThrow('Unsupported mint');
  });

  it('should throw error for invalid base58 string', () => {
    expect(() => resolveMintFlexible('not-a-valid-base58')).toThrow('Unsupported mint');
  });

  it('should throw error for empty string', () => {
    expect(() => resolveMintFlexible('')).toThrow('Unsupported mint');
  });

  it('should resolve real USDC mint pubkey (EPjFWdd...)', () => {
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const result = resolveMintFlexible(usdcMint);
    expect(result.toBase58()).toBe(usdcMint);
    // Should also match the constant
    expect(result.toBase58()).toBe(USDC_MINT);
  });
});
