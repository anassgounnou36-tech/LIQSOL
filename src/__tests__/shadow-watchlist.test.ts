import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('loadShadowWatchTargets', () => {
  const originalCwd = process.cwd();
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liqsol-shadow-watch-'));
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    process.env.SHADOW_WATCH_TOPK = '50';
    process.env.SHADOW_WATCH_INCLUDE_MEDIUM_HORIZON = 'true';
    process.env.SHADOW_WATCH_MAX_TTL_MIN = '60';
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('includes queue targets and shadow-only ranked candidates while excluding queue duplicates', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'tx_queue.json'),
      JSON.stringify([
        { key: 'queue-1', assets: ['SOL'], repayReservePubkey: 'repay-q1', collateralReservePubkey: 'coll-q1' },
      ]),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'candidates.json'),
      JSON.stringify({
        candidates: [
          { key: 'queue-1', rankBucket: 'near-ready', forecast: { ttlMinutes: 5 } },
          { key: 'cand-near', rankBucket: 'near-ready', forecast: { ttlMinutes: 10 } },
          { key: 'cand-medium', rankBucket: 'medium-horizon', forecast: { ttlMinutes: 20 } },
        ],
      }),
    );

    vi.resetModules();
    const { loadShadowWatchTargets } = await import('../monitoring/shadowWatchlist.js');
    const result = loadShadowWatchTargets();

    expect(result.queueTargets.map((x) => x.key)).toEqual(['queue-1']);
    expect(result.shadowOnlyTargets.map((x) => x.key)).toEqual(['cand-near', 'cand-medium']);
    expect(result.allTargets.map((x) => x.key)).toEqual(['queue-1', 'cand-near', 'cand-medium']);
  });

  it('obeys medium-horizon toggle, excludes far/legacy, and enforces topK', async () => {
    process.env.SHADOW_WATCH_INCLUDE_MEDIUM_HORIZON = 'false';
    process.env.SHADOW_WATCH_TOPK = '2';
    fs.writeFileSync(path.join(tmpDir, 'data', 'tx_queue.json'), JSON.stringify([]));
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'candidates.json'),
      JSON.stringify({
        candidates: [
          { key: 'liq-1', rankBucket: 'liquidatable', forecast: { ttlMinutes: 1 } },
          { key: 'near-1', rankBucket: 'near-ready', forecast: { ttlMinutes: 5 } },
          { key: 'med-1', rankBucket: 'medium-horizon', forecast: { ttlMinutes: 10 } },
          { key: 'far-1', rankBucket: 'far-horizon', forecast: { ttlMinutes: 10 } },
          { key: 'legacy-1', rankBucket: 'legacy-or-unknown', forecast: { ttlMinutes: 10 } },
        ],
      }),
    );

    vi.resetModules();
    const { loadShadowWatchTargets } = await import('../monitoring/shadowWatchlist.js');
    const result = loadShadowWatchTargets();

    expect(result.shadowOnlyTargets.map((x) => x.key)).toEqual(['liq-1', 'near-1']);
  });

  it('enforces max TTL threshold for finite ttlMinutes values', async () => {
    process.env.SHADOW_WATCH_MAX_TTL_MIN = '15';
    fs.writeFileSync(path.join(tmpDir, 'data', 'tx_queue.json'), JSON.stringify([]));
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'candidates.json'),
      JSON.stringify({
        candidates: [
          { key: 'near-ok', rankBucket: 'near-ready', forecast: { ttlMinutes: 5 } },
          { key: 'near-too-far', rankBucket: 'near-ready', forecast: { ttlMinutes: 30 } },
          { key: 'near-unknown-ttl', rankBucket: 'near-ready', forecast: { ttlMinutes: null } },
        ],
      }),
    );

    vi.resetModules();
    const { loadShadowWatchTargets } = await import('../monitoring/shadowWatchlist.js');
    const result = loadShadowWatchTargets();

    expect(result.shadowOnlyTargets.map((x) => x.key)).toEqual(['near-ok', 'near-unknown-ttl']);
  });
});
