import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

describe('refreshObligation referrer + farms-aware downshift guards', () => {
  it('adds robust referrer parsing and referrer debug output', () => {
    const source = read('src/kamino/liquidationBuilder.ts');
    expect(source).toContain('function parsePublicKeyish(v: unknown): PublicKey | null');
    expect(source).toContain('[LiqBuilder][DEBUG_REFRESH_OBLIGATION] referrerParsed=');
    expect(source).toContain('Buffer.from("referrer_acc")');
  });

  it('builds refresh-obligation reserve lists from active nonzero slots', () => {
    const source = read('src/kamino/liquidationBuilder.ts');
    expect(source).toContain('const depositsAll = obligation.state.deposits.filter');
    expect(source).toContain('const borrowsAll = obligation.state.borrows.filter');
    expect(source).toContain('const deposits = depositsAll.filter((d: any) => gtZero(d.depositedAmount));');
    expect(source).toContain('const borrows = borrowsAll.filter((b: any) => gtZero(b.borrowedAmountSf));');
    expect(source).toContain('depositsAll(non-default)');
    expect(source).toContain('borrowsAll(non-default)');
  });

  it('threads farmRequiredModes metadata through canonical and plan builders', () => {
    const liquidationBuilder = read('src/kamino/liquidationBuilder.ts');
    const canonical = read('src/kamino/canonicalLiquidationIxs.ts');
    const planBuilder = read('src/execute/planTxBuilder.ts');

    expect(liquidationBuilder).toContain('farmRequiredModes: number[]');
    expect(canonical).toContain('farmRequiredModes: liquidationResult.farmRequiredModes');
    expect(planBuilder).toContain('farmRequiredModes');
  });

  it('dumps program logs for seized-delta simulation failures', () => {
    const source = read('src/execute/seizedDeltaEstimator.ts');
    expect(source).toContain('[SeizedDelta] ═══ PROGRAM LOGS ═══');
  });

  it('keeps farms-off downshift profiles disabled when farms are required', () => {
    const executor = read('src/execute/executor.ts');
    const presubmitter = read('src/presubmit/presubmitter.ts');

    expect(executor).toContain('const farmsRequired = result.metadata.farmRequiredModes.length > 0;');
    expect(executor).toContain('if (farmsRequired) {');
    expect(executor).toContain("{ disableFarmsRefresh: false, preReserveRefreshMode: 'primary' }");

    expect(presubmitter).toContain('const farmsRequired = candidate.farmRequiredModes.length > 0;');
    expect(presubmitter).toContain('if (farmsRequired) {');
    expect(presubmitter).toContain("{ disableFarmsRefresh: false, preReserveRefreshMode: 'primary' }");
  });
});
