import { config } from 'dotenv';
import { z } from 'zod';
import { existsSync } from 'fs';
import { resolve } from 'path';

// Load .env file
config();

// Define schema with custom validation for file existence
const envSchema = z.object({
  BOT_KEYPAIR_PATH: z.string().min(1, 'BOT_KEYPAIR_PATH is required').refine(
    (path) => {
      const resolvedPath = resolve(path);
      return existsSync(resolvedPath);
    },
    (path) => ({
      message: `BOT_KEYPAIR_PATH does not exist: ${resolve(path)}`,
    })
  ),
  RPC_URL: z.string().url('RPC_URL must be a valid URL'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

// Parse and validate environment variables
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment validation failed:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;