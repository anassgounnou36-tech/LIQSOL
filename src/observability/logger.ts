import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const isDev = process.env.NODE_ENV !== "production";

export const logger = pino(
  { level },
  isDev
    ? pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
          destination: 2 // Write to stderr (fd=2)
        }
      })
    : pino.destination(2) // Production: write to stderr (fd=2)
);