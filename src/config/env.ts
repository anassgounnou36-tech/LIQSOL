import { config as dotenvConfig } from "dotenv";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

export const EnvSchema = z.object({
  RPC_PRIMARY: z.string().url(),
  RPC_SECONDARY: z.string().url().optional(),
  WS_PRIMARY: z.string().url().optional(),
  WS_SECONDARY: z.string().url().optional(),

  BOT_KEYPAIR_PATH: z.string().min(1),

  KAMINO_MARKET_PUBKEY: z.string().min(1),
  KAMINO_KLEND_PROGRAM_ID: z.string().min(1),

  YELLOWSTONE_GRPC_URL: z.string().url(),
  YELLOWSTONE_X_TOKEN: z.string().min(1),

  SNAPSHOT_MAX_SECONDS: z.coerce.number().positive().default(180),
  SNAPSHOT_INACTIVITY_SECONDS: z.coerce.number().positive().default(30),
  INDEXER_INTERVAL_MS: z.coerce.number().positive().default(5000),

  LOG_LEVEL: z.enum(["fatal","error","warn","info","debug","trace"]).default("info"),
  NODE_ENV: z.enum(["development","production","test"]).default("development"),
  
  // Optional: comma-separated list of liquidity mint addresses for allowlist filtering (PR7 gate)
  // Example: "So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  // Deprecated execution allowlist key (kept for backward compatibility).
  LIQSOL_LIQ_MINT_ALLOWLIST: z.string().optional(),
  LIQSOL_EXEC_MINT_ALLOWLIST: z.string().optional(),

  // Health ratio source selection
  // - recomputed: use fresh oracle+reserve recompute only
  // - hybrid: use protocol-derived weights on recomputed totals when available, else recomputed
  // - protocol: use program's SF values (ground truth, handles elevation groups/farms)
  LIQSOL_HEALTH_SOURCE: z.enum(['recomputed', 'protocol', 'hybrid']).optional(),
  LIQSOL_RECOMPUTED_VERIFY_BACKEND: z.enum(['none', 'klend-sdk']).optional().default('none'),
  LIQSOL_RECOMPUTED_VERIFY_TOP_K: z.coerce.number().optional().default(200),
  LIQSOL_RECOMPUTED_VERIFY_CONCURRENCY: z.coerce.number().optional().default(8),
  LIQSOL_RECOMPUTED_VERIFY_TTL_MS: z.coerce.number().optional().default(15_000),

  // PR 8.5: EV-based ranking configuration (opt-in)
  USE_EV_RANKING: z.string().optional().default('false'),
  MIN_BORROW_USD: z.string().optional().default('10'),
  HAZARD_ALPHA: z.string().optional().default('25'),
  EV_CLOSE_FACTOR: z.string().optional().default('0.5'),
  EV_LIQUIDATION_BONUS_PCT: z.string().optional().default('0.05'),
  EV_MIN_LIQUIDATION_BONUS_PCT: z.string().optional().default('0.02'),
  EV_BONUS_FULLY_SEVERE_HR_GAP: z.string().optional().default('0.10'),
  EV_FLASHLOAN_FEE_PCT: z.string().optional().default('0.002'),
  EV_FIXED_GAS_USD: z.string().optional().default('0.5'),
  EV_SLIPPAGE_BUFFER_PCT: z.string().optional(), // optional, no default
  EV_SAME_MINT_SLIPPAGE_BUFFER_PCT: z.string().optional().default('0'),

  // PR 8.6: Forecast caching and TTL parameters
  FORECAST_TTL_MS: z.string().optional().default('300000'),
  TTL_VOLATILE_MOVE_PCT_PER_MIN: z.string().optional(),
  TTL_STABLE_MOVE_PCT_PER_MIN: z.string().optional().default('0.02'),
  TTL_SOL_DROP_PCT_PER_MIN: z.string().optional().default('0.2'),
  TTL_MAX_DROP_PCT: z.string().optional().default('20'),

  // PR 8.7: Forecast ranking for flashloan dry-run
  USE_FORECAST_FOR_DRYRUN: z.string().optional().default('false'),
  FORECAST_WEIGHT_EV: z.string().optional().default('0.75'),
  FORECAST_WEIGHT_TTL: z.string().optional().default('0.25'),

  // PR10: Scheduler thresholds
  SCHED_MIN_EV: z.string().optional().default('0'),
  SCHED_MAX_TTL_MIN: z.string().optional().default('10'),
  SCHED_MIN_HAZARD: z.string().optional().default('0.05'),
  SCHED_FORCE_INCLUDE_LIQUIDATABLE: z.string().optional().default('false'),

  // Live runner refresh interval
  LIVE_CANDIDATE_REFRESH_INTERVAL_MS: z.string().optional().default('120000'),
  
  // Queue build mode (replace or merge)
  QUEUE_BUILD_MODE: z.enum(['replace', 'merge']).optional().default('replace'),
  
  // Executor multi-attempt per cycle
  BOT_MAX_ATTEMPTS_PER_CYCLE: z.string().optional().default('10'),

  // PR11: Forecast TTL management and EV-based refresh thresholds
  FORECAST_MAX_AGE_MS: z.string().optional().default('300000'),
  SCHED_REFRESH_INTERVAL_MS: z.string().optional().default('30000'),
  SCHED_EV_DROP_PCT: z.string().optional().default('0.15'),
  SCHED_TTL_EXPIRED_MARGIN_MIN: z.string().optional().default('2'),
  SCHED_MIN_REFRESH_INTERVAL_MS: z.string().optional().default('60000'),

  // PR12: Scheduler batch limit for refresh queue
  SCHED_REFRESH_BATCH_LIMIT: z.string().optional().default('25'),

  // PR12: Execution thresholds for dry-run executor
  EXEC_MIN_EV: z.string().optional().default('0'),
  EXEC_MAX_TTL_MIN: z.string().optional().default('10'),
  EXEC_READY_TTL_MAX_MIN: z.string().optional().default('0.25'),
  EXEC_KLEND_VERIFY_ENABLED: z.string().optional().default('false'),
  EXEC_KLEND_VERIFY_TOPK: z.string().optional().default('3'),
  EXEC_KLEND_VERIFY_TTL_WINDOW_MIN: z.string().optional().default('2'),
  EXEC_KLEND_HEALTHY_COOLDOWN_MS: z.string().optional().default('15000'),
  EXEC_PRIORITY_FEE_MODE: z.enum(['static', 'recent-fees']).optional().default('static'),
  EXEC_PRIORITY_FEE_PERCENTILE: z.string().optional().default('75'),
  EXEC_PRIORITY_FEE_FLOOR_MICROLAMPORTS: z.string().optional().default('10000'),
  EXEC_PRIORITY_FEE_CAP_MICROLAMPORTS: z.string().optional().default('250000'),
  EXEC_PRIORITY_FEE_SAMPLE_ACCOUNTS_LIMIT: z.string().optional().default('64'),
  EXEC_SEND_MODE: z.enum(['rpc', 'jito']).optional().default('rpc'),
  JITO_BLOCK_ENGINE_TX_URL: z.string().optional().default('https://mainnet.block-engine.jito.wtf/api/v1/transactions'),
  JITO_BLOCK_ENGINE_BUNDLES_URL: z.string().optional().default('https://mainnet.block-engine.jito.wtf/api/v1/bundles'),
  JITO_BUNDLE_ONLY: z.string().optional().default('true'),
  JITO_TIP_LAMPORTS: z.string().optional().default('1000'),
  JITO_TIP_ACCOUNT_CACHE_MS: z.string().optional().default('300000'),
  EXEC_EARLY_GRACE_MS: z.string().optional().default('3000'),
  EXEC_MIN_FEE_PAYER_SOL: z.string().optional().default('0.05'),
  EXEC_DRY_RUN_SETUP_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).optional().default(300),
  EXECUTOR_LUT_ADDRESS: z.string().optional(),
  EXECUTOR_LUT_MANAGE: z.string().optional().default('false'),
  EXECUTOR_LUT_WARMUP_ONLY: z.string().optional().default('false'),
  EXECUTOR_LUT_WARMUP_TOPK: z.string().optional().default('3'),
  SCHEDULED_MIN_LIQUIDATION_DELAY_MS: z.string().optional().default('0'),

  // Candidate selection tuning
  CAND_TOP: z.string().optional().default('50'),
  CAND_NEAR: z.string().optional().default('1.02'),
  CAND_VALIDATE_SAMPLES: z.string().optional().default('0'),

  // Scheduler max plans per cycle
  SCHED_MAX_PLANS_PER_CYCLE: z.string().optional().default('100'),

  // TTL expiry configuration
  TTL_GRACE_MS: z.string().optional().default('60000'), // 60 seconds grace period after predicted liquidation
  TTL_UNKNOWN_PASSES: z.string().optional().default('true'), // Whether plans with unknown TTL should pass (not be marked expired)

  // Presubmit cache
  PRESUBMIT_ENABLED: z.string().optional().default('false'),
  PRESUBMIT_TOPK: z.string().optional().default('5'),
  PRESUBMIT_TTL_MS: z.string().optional().default('60000'),
  PRE_RESERVE_REFRESH_MODE: z.enum(['all', 'primary', 'auto']).optional().default('auto'),
  ALLOW_UNSAFE_PRIMARY_REFRESH: z.string().optional().default('false'),
  METRICS_ENABLED: z.string().optional().default('true'),
  METRICS_DIR: z.string().optional().default('data/metrics'),
  TELEGRAM_ENABLED: z.string().optional().default('false'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_NOTIFY_QUEUE_ADDED: z.string().optional().default('true'),
  TELEGRAM_NOTIFY_EXECUTION_STARTED: z.string().optional().default('true'),
  TELEGRAM_NOTIFY_EXECUTION_RESULTS: z.string().optional().default('true'),
  TELEGRAM_NOTIFY_FAILURES: z.string().optional().default('true'),
  TELEGRAM_NOTIFY_MIN_EV: z.string().optional().default('0'),
  TELEGRAM_NOTIFY_MAX_QUEUE_PER_REFRESH: z.string().optional().default('3'),
  TELEGRAM_DISABLE_NOTIFICATION: z.string().optional().default('false'),
});

export type Env = z.infer<typeof EnvSchema>;

// Read-only schema for commands that don't require a keypair (snapshot, decode, healthcheck)
// Uses schema composition to avoid duplication
export const ReadonlyEnvSchema = EnvSchema.omit({ BOT_KEYPAIR_PATH: true });

export type ReadonlyEnv = z.infer<typeof ReadonlyEnvSchema>;

export function loadReadonlyEnv(injectedEnv?: Record<string, string | undefined>): ReadonlyEnv {
  // Load dotenv only when env is actually needed
  if (!injectedEnv) {
    dotenvConfig();
  }

  const envToValidate = injectedEnv ?? process.env;
  const parsed = ReadonlyEnvSchema.safeParse(envToValidate);
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid .env:\n${msg}`);
  }

  if (
    parsed.data.TELEGRAM_ENABLED === 'true' &&
    (!parsed.data.TELEGRAM_BOT_TOKEN || !parsed.data.TELEGRAM_CHAT_ID)
  ) {
    throw new Error('Invalid .env:\nTELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when TELEGRAM_ENABLED=true');
  }

  return parsed.data;
}

export function loadEnv(injectedEnv?: Record<string, string | undefined>): Env {
  // Load dotenv only when env is actually needed
  if (!injectedEnv) {
    dotenvConfig();
  }

  const envToValidate = injectedEnv ?? process.env;
  const parsed = EnvSchema.safeParse(envToValidate);
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid .env:\n${msg}`);
  }

  if (
    parsed.data.TELEGRAM_ENABLED === 'true' &&
    (!parsed.data.TELEGRAM_BOT_TOKEN || !parsed.data.TELEGRAM_CHAT_ID)
  ) {
    throw new Error('Invalid .env:\nTELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when TELEGRAM_ENABLED=true');
  }

  // In tests, allow BOT_KEYPAIR_PATH to be dummy if you want; otherwise keep strict.
  if (parsed.data.NODE_ENV !== "test") {
    const resolved = path.resolve(parsed.data.BOT_KEYPAIR_PATH);
    if (!fs.existsSync(resolved)) {
      throw new Error(`BOT_KEYPAIR_PATH does not exist: ${resolved}`);
    }
  }

  if (
    parsed.data.NODE_ENV === "production" &&
    parsed.data.PRE_RESERVE_REFRESH_MODE === "primary" &&
    parsed.data.ALLOW_UNSAFE_PRIMARY_REFRESH !== "true"
  ) {
    throw new Error(
      "Unsafe configuration: PRE_RESERVE_REFRESH_MODE=primary is blocked in production. Set ALLOW_UNSAFE_PRIMARY_REFRESH=true to explicitly override."
    );
  }

  return parsed.data;
}
