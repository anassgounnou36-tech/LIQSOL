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