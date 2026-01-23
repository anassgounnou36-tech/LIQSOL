import { describe, it, expect } from 'vitest';
import { loadEnv } from '../config/env.js';

describe('Environment Tests', () => {
  it('should throw when required vars are missing', () => {
    expect(() => loadEnv({})).toThrow('Invalid .env');
  });

  it('should accept injected env vars', () => {
    const mockEnv = {
      RPC_PRIMARY: 'https://api.mainnet-beta.solana.com',
      BOT_KEYPAIR_PATH: '/tmp/keypair.json',
      KAMINO_MARKET_PUBKEY: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
      KAMINO_KLEND_PROGRAM_ID: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
      LOG_LEVEL: 'info',
      NODE_ENV: 'test'
    };
    
    const env = loadEnv(mockEnv);
    expect(env.RPC_PRIMARY).toBe('https://api.mainnet-beta.solana.com');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.NODE_ENV).toBe('test');
  });

  it('should throw when RPC_PRIMARY is not a valid URL', () => {
    const mockEnv = {
      RPC_PRIMARY: 'not-a-url',
      BOT_KEYPAIR_PATH: '/tmp/keypair.json',
      KAMINO_MARKET_PUBKEY: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
      KAMINO_KLEND_PROGRAM_ID: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
      NODE_ENV: 'test'
    };
    
    expect(() => loadEnv(mockEnv)).toThrow('Invalid .env');
  });
});