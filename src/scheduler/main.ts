#!/usr/bin/env node
import { startBotStartupScheduler } from './botStartupScheduler.js';

/**
 * CLI entry point for the scheduler
 * Starts the bot startup scheduler with Yellowstone listeners and event-driven refresh
 */
async function main() {
  try {
    await startBotStartupScheduler();
  } catch (err) {
    console.error('[Scheduler] Fatal error:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
