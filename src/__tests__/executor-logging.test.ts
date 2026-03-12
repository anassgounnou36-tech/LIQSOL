import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({
  EXEC_MIN_EV: '0',
  EXEC_MAX_TTL_MIN: '120',
  EXEC_MIN_FEE_PAYER_SOL: '0.01',
  TTL_GRACE_MS: '60000',
  EXEC_READY_TTL_MAX_MIN: '0.25',
  EXEC_EARLY_GRACE_MS: '3000',
  TTL_UNKNOWN_PASSES: 'false',
  SCHED_FORCE_INCLUDE_LIQUIDATABLE: 'false',
}));

const mockState = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  loadEnv: vi.fn(() => ({
    EXEC_MIN_EV: envState.EXEC_MIN_EV,
    EXEC_MAX_TTL_MIN: envState.EXEC_MAX_TTL_MIN,
    EXEC_MIN_FEE_PAYER_SOL: envState.EXEC_MIN_FEE_PAYER_SOL,
    TTL_GRACE_MS: envState.TTL_GRACE_MS,
    EXEC_READY_TTL_MAX_MIN: envState.EXEC_READY_TTL_MAX_MIN,
    EXEC_EARLY_GRACE_MS: envState.EXEC_EARLY_GRACE_MS,
    TTL_UNKNOWN_PASSES: envState.TTL_UNKNOWN_PASSES,
    SCHED_FORCE_INCLUDE_LIQUIDATABLE: envState.SCHED_FORCE_INCLUDE_LIQUIDATABLE,
    EXEC_DRY_RUN_SETUP_CACHE_TTL_SECONDS: '300',
    PRESUBMIT_ENABLED: 'false',
    PRESUBMIT_TOPK: '5',
    EXECUTOR_LUT_WARMUP_ONLY: 'false',
    EXECUTOR_LUT_WARMUP_TOPK: '3',
    SCHED_MIN_EV: '0',
    SCHED_MAX_TTL_MIN: '10',
  })),
}));

vi.mock('../solana/connection.js', () => ({
  getConnection: vi.fn(() => ({})),
}));

vi.mock('../observability/logger.js', () => ({
  logger: {
    info: mockState.info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('executor logging', () => {
  let originalCwd: string;
  let tmpDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-logging-test-'));
    process.chdir(tmpDir);
    mockState.info.mockReset();
    envState.EXEC_MAX_TTL_MIN = '120';
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    consoleLogSpy.mockRestore();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('logs threshold snapshot only on first run and when env snapshot changes', async () => {
    const { runDryExecutor } = await import('../execute/executor.js');
    await runDryExecutor({ dry: true, broadcast: false });
    await runDryExecutor({ dry: true, broadcast: false });

    let thresholdLogs = mockState.info.mock.calls.filter(
      ([first, second]) => second === '[Executor] Filter thresholds' && first && typeof first === 'object',
    );
    expect(thresholdLogs).toHaveLength(1);

    envState.EXEC_MAX_TTL_MIN = '240';
    await runDryExecutor({ dry: true, broadcast: false });
    thresholdLogs = mockState.info.mock.calls.filter(
      ([first, second]) => second === '[Executor] Filter thresholds' && first && typeof first === 'object',
    );
    expect(thresholdLogs).toHaveLength(2);
  });

  it('does not emit legacy queue-empty reminder line', async () => {
    const { runDryExecutor } = await import('../execute/executor.js');
    const result = await runDryExecutor({ dry: true, broadcast: false });
    expect(result.status).toBe('no-plans');
    const legacyLoggerLine = mockState.info.mock.calls.find(
      ([, second]) => typeof second === 'string' && second.includes('No plans available. Ensure data/tx_queue.json exists (PR10/PR11).'),
    );
    expect(legacyLoggerLine).toBeUndefined();
    const legacyConsoleLine = consoleLogSpy.mock.calls.find(
      ([first]) => typeof first === 'string' && first.includes('No plans available. Ensure data/tx_queue.json exists (PR10/PR11).'),
    );
    expect(legacyConsoleLine).toBeUndefined();
  });
});
