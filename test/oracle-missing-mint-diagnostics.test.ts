import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('oracle missing-mint diagnostics', () => {
  it('logs reserve details including scope and pyth/switchboard oracle pubkeys', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/cache/oracleCache.ts'), 'utf8');
    const reserveCacheSource = fs.readFileSync(path.resolve(process.cwd(), 'src/cache/reserveCache.ts'), 'utf8');
    const envExampleSource = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
    expect(source).toContain('const SCOPE_MAX_AGE_SEC = Number(process.env.LIQSOL_SCOPE_MAX_AGE_SECONDS ?? 180);');
    expect(source).toContain('const lastScopeStaleWarnMs = new Map<string, number>();');
    expect(source).toContain('Scope chain price is stale (rate-limited)');
    expect(source).toContain('Scope decode returned null');
    expect(source).toContain('[OracleCache] Unpriced required mint diagnostics');
    expect(source).toContain('missingMintDiagnostics');
    expect(source).toContain('scopeOraclePubkey');
    expect(reserveCacheSource).toContain('scopeOraclePubkey?: string | null;');
    expect(reserveCacheSource).toContain('scopeOraclePubkey: decoded.scopeOraclePubkey ?? null,');
    expect(envExampleSource).toContain('LIQSOL_SCOPE_MAX_AGE_SECONDS=180');
  });
});
