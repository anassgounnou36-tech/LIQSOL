import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('oracle missing-mint diagnostics', () => {
  it('logs reserve details including scope and pyth/switchboard oracle pubkeys', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/cache/oracleCache.ts'), 'utf8');
    expect(source).toContain('scopePriceChainRaw');
    expect(source).toContain('scopePriceChainFiltered');
    expect(source).toContain('pythOraclePubkeys');
    expect(source).toContain('switchboardOraclePubkeys');
    expect(source).toContain('[OracleCache] Unpriced required mint reserve details');
  });
});
