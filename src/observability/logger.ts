import pino from "pino";
import { loadEnv } from "../config/env.js";

let level = "info";
try {
  level = loadEnv().LOG_LEVEL;
} catch {
  // during tests or no env loaded yet
}

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino(
  { level },
  isDev
    ? pino.transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" }
      })
    : undefined
);