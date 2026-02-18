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
  // Default: SOL+USDC for PR7 gate behavior. Set to empty string to disable allowlist.
  LIQSOL_LIQ_MINT_ALLOWLIST: z.string().optional(),

  // PR 8.5: EV-based ranking configuration (opt-in)
  USE_EV_RANKING: z.string().optional().default('false'),
  MIN_BORROW_USD: z.string().optional().default('10'),
  HAZARD_ALPHA: z.string().optional().default('25'),
  EV_CLOSE_FACTOR: z.string().optional().default('0.5'),
  EV_LIQUIDATION_BONUS_PCT: z.string().optional().default('0.05'),
  EV_FLASHLOAN_FEE_PCT: z.string().optional().default('0.002'),
  EV_FIXED_GAS_USD: z.string().optional().default('0.5'),
  EV_SLIPPAGE_BUFFER_PCT: z.string().optional(), // optional, no default

  // PR 8.6: Forecast caching and TTL parameters
  FORECAST_TTL_MS: z.string().optional().default('300000'),
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
  SCHED_FORCE_INCLUDE_LIQUIDATABLE: z.string().optional().default('true'),

  // Live runner refresh interval
  LIVE_CANDIDATE_REFRESH_INTERVAL_MS: z.string().optional().default('120000'),

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

  // In tests, allow BOT_KEYPAIR_PATH to be dummy if you want; otherwise keep strict.
  if (parsed.data.NODE_ENV !== "test") {
    const resolved = path.resolve(parsed.data.BOT_KEYPAIR_PATH);
    if (!fs.existsSync(resolved)) {
      throw new Error(`BOT_KEYPAIR_PATH does not exist: ${resolved}`);
    }
  }

  return parsed.data;
}