import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('bot:run broadcast env loading order', () => {
  const runTsPath = path.resolve(process.cwd(), 'src/bot/run.ts');
  const source = fs.readFileSync(runTsPath, 'utf8');

  it('loads env before parsing args in main()', () => {
    const loadEnvIdx = source.indexOf('const env = loadEnv();');
    const parseArgsIdx = source.indexOf('const opts = parseArgs();');

    expect(loadEnvIdx).toBeGreaterThanOrEqual(0);
    expect(parseArgsIdx).toBeGreaterThanOrEqual(0);
    expect(loadEnvIdx).toBeLessThan(parseArgsIdx);
  });

  it('accepts case-insensitive truthy env values for LIQSOL_BROADCAST', () => {
    expect(source).toContain("['true', '1', 'yes'].includes((process.env.LIQSOL_BROADCAST ?? '').toLowerCase())");
  });
});
