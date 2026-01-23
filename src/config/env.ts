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

  LOG_LEVEL: z.enum(["fatal","error","warn","info","debug","trace"]).default("info"),
  NODE_ENV: z.enum(["development","production","test"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  // Load dotenv only when env is actually needed
  dotenvConfig();

  const parsed = EnvSchema.safeParse(process.env);
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