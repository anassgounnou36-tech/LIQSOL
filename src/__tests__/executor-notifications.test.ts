import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const EXECUTOR_PATH = path.join(process.cwd(), 'src', 'execute', 'executor.ts');

describe('executor started-notification timing', () => {
  it('uses one-shot emitExecutionStartedIfNeeded helper and calls it only at send-ready paths', () => {
    const source = fs.readFileSync(EXECUTOR_PATH, 'utf8');
    expect(source).toContain('let startedEventEmitted = false;');
    expect(source).toContain('async function emitExecutionStartedIfNeeded(): Promise<void> {');
    expect(source).toContain("if (startedEventEmitted) return;");
    expect(source).toContain("kind: 'execution-attempt-started'");
    expect(source).toContain('startedEventEmitted = true;');

    expect(source).toMatch(/await emitExecutionStartedIfNeeded\(\);\s*const setupAttempts = await sendWithBoundedRetry\(/);
    expect(source).toMatch(/await emitExecutionStartedIfNeeded\(\);\s*const atomicAttempts = await sendWithRebuildRetry\(/);
    expect(source).toMatch(/await emitExecutionStartedIfNeeded\(\);\s*const attempts = await sendWithRebuildRetry\(/);
  });

  it('keeps execution-attempt-result emission path unchanged', () => {
    const source = fs.readFileSync(EXECUTOR_PATH, 'utf8');
    expect(source).toContain("kind: 'execution-attempt-result'");
    expect(source).toContain('await emitBotEvent(event);');
    expect(source).toContain('await maybeNotifyForBotEvent(event);');
  });
});
