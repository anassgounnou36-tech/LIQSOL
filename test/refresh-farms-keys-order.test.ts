import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildRefreshFarmsKeys } from '../src/kamino/liquidationBuilder.js';

describe('buildRefreshFarmsKeys', () => {
  it('builds keys in IDL-flattened order with reserveFarmState at index 4', () => {
    const crank = new PublicKey('11111111111111111111111111111112');
    const obligation = new PublicKey('11111111111111111111111111111113');
    const lendingMarketAuthority = new PublicKey('11111111111111111111111111111114');
    const reserve = new PublicKey('11111111111111111111111111111115');
    const reserveFarmState = new PublicKey('11111111111111111111111111111116');
    const obligationFarmUserState = new PublicKey('11111111111111111111111111111117');
    const lendingMarket = new PublicKey('11111111111111111111111111111118');

    const keys = buildRefreshFarmsKeys({
      crank,
      obligation,
      lendingMarketAuthority,
      reserve,
      reserveFarmState,
      obligationFarmUserState,
      lendingMarket,
    });

    expect(keys).toHaveLength(10);
    expect(keys[0]).toMatchObject({ pubkey: crank, isSigner: true, isWritable: true });
    expect(keys[1]).toMatchObject({ pubkey: obligation, isSigner: false, isWritable: false });
    expect(keys[2]).toMatchObject({ pubkey: lendingMarketAuthority, isSigner: false, isWritable: true });
    expect(keys[3]).toMatchObject({ pubkey: reserve, isSigner: false, isWritable: false });
    expect(keys[4]).toMatchObject({ pubkey: reserveFarmState, isSigner: false, isWritable: true });
    expect(keys[5]).toMatchObject({ pubkey: obligationFarmUserState, isSigner: false, isWritable: true });
    expect(keys[6]).toMatchObject({ pubkey: lendingMarket, isSigner: false, isWritable: false });
    expect(keys[7]).toMatchObject({ pubkey: new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr'), isSigner: false, isWritable: false });
    expect(keys[8]).toMatchObject({ pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false });
    expect(keys[9]).toMatchObject({ pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false });
  });
});
